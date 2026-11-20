import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

export const OFFICIAL_BOOKING_URL = 'https://usc.kuleuven.cloud/bookings/rent?tags=132';
const OFFICIAL_ORIGIN = 'https://usc.kuleuven.cloud';
const adapterSource = readFile(new URL('./adapter.js', import.meta.url), 'utf8');
const DEFAULT_HOSTS = [
  'usc.kuleuven.cloud', 'idp.kuleuven.be',
  'backbone-web-api.production.leuven.delcom.nl',
  'storage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
];
const message = (text, status = 409) => Object.assign(new Error(text), { status, statusCode: status });

export function allowedBrowserUrl(value, hosts = DEFAULT_HOSTS) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname); }
  catch { return value === 'about:blank'; }
}

export class BookingProvider {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.launch = options.launch ?? (opts => chromium.launch(opts));
    this.browserPromise = null;
    this.contexts = new Set();
    this.hosts = [...DEFAULT_HOSTS, ...(config.loginAllowedHosts ?? [])];
  }
  async browser() {
    if (!this.browserPromise) {
      // Login pages process credentials: keep Chromium's OS sandbox enabled. If the
      // host/container cannot support it, startup fails; never retry with --no-sandbox.
      this.browserPromise = this.launch({ chromiumSandbox: true, headless: this.config.headless !== false, ...(this.config.browserExecutablePath ? {executablePath:this.config.browserExecutablePath} : this.config.browserChannel ? { channel: this.config.browserChannel } : {}) });
      this.browserPromise.catch(() => { this.browserPromise = null; });
      const b = await this.browserPromise;
      b.once('disconnected', () => { this.browserPromise = null; });
    }
    return this.browserPromise;
  }
  async createContext(storageState) {
    const browser = await this.browser();
    const context = await browser.newContext({
      viewport: { width: 1100, height: 820 }, locale: 'en-GB', timezoneId: 'Europe/Brussels',
      acceptDownloads: false, serviceWorkers: 'block',
      ...(storageState ? { storageState } : {}),
    });
    this.contexts.add(context);
    context.on('close', () => this.contexts.delete(context));
    // Remote login is not a general-purpose proxy: deny arbitrary origins, local network URLs,
    // downloads and service workers. Additional exact SSO hosts require operator configuration.
    await context.route('**/*', async route => {
      const u = route.request().url();
      if (allowedBrowserUrl(u, this.hosts)) await route.continue();
      else await route.abort('blockedbyclient');
    });
    context.on('page', page => { page.on('download', download => download.cancel().catch(() => {})); });
    await context.addInitScript({ content: await adapterSource });
    return context;
  }
  async officialPage(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(this.config.bookingUrl ?? OFFICIAL_BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.assertOfficial(page);
    return page;
  }
  async assertOfficial(page) {
    if (new URL(page.url()).origin !== OFFICIAL_ORIGIN) throw message('Reconnect your booking account. The official site requires sign-in.');
    await page.waitForFunction(() => !!globalThis.CourtAdapter && !!document.querySelector('[data-test-id="native-date-picker-input"]'), null, { timeout: 15000 });
  }
  async readIdentity(page) {
    if (!this.config.providerIdentitySelector) return {kind:'visible_account_label',verified:false};
    const value = await page.evaluate(({selector,attribute}) => {
      const nodes=document.querySelectorAll(selector);
      if(nodes.length!==1)return null;
      return (attribute?nodes[0].getAttribute(attribute):nodes[0].textContent)?.trim()||null;
    }, {selector:this.config.providerIdentitySelector,attribute:this.config.providerIdentityAttribute??''});
    if(typeof value!=='string'||!value||value.length>256)throw message('The configured account identity field could not be verified. Contact the host.');
    return {kind:'configured_dom_identity',id:createHash('sha256').update(`${OFFICIAL_ORIGIN}\n${value}`).digest('hex'),verified:true};
  }
  async assertAccount(page, expected, expectedIdentity) {
    await this.assertOfficial(page);
    const label = await page.evaluate(() => globalThis.CourtAdapter.account());
    if (!label || label !== expected) throw message('The signed-in account changed or expired. Reconnect and test again.');
    if(expectedIdentity?.verified){
      const identity=await this.readIdentity(page);
      if(!identity.verified||identity.id!==expectedIdentity.id)throw message('The provider account identity changed. Reconnect and test again.');
    }
  }
  async prepare(job, connection, storageState) {
    if (!storageState || connection?.status !== 'connected' || !connection.accountLabel) throw message('Connect your booking account before preparing a booking.');
    const context = await this.createContext(storageState);
    try {
      const pages = await Promise.all([this.officialPage(context), this.officialPage(context)]);
      const available = await Promise.all(pages.map(async (page, index) => {
        await this.assertAccount(page, connection.accountLabel,connection.identity);
        return page.evaluate(async ({ date, hour, courts }) => {
          await CourtAdapter.selectDate(date);
          const found = await CourtAdapter.selectHour(date, hour);
          return courts.filter(c => found.includes(c));
        }, { date: job.date, hour: job.start + index, courts: job.courts });
      }));
      if (available.some(c => !c.length)) throw message('No permitted court is selectable for one of the requested hours.');
      return { context, pages, available, accountLabel: connection.accountLabel, identity:connection.identity, jobId: job.id, closed: false };
    } catch (error) { await context.close().catch(() => {}); throw error; }
  }
  async test(job, connection, storageState) {
    const prepared = await this.prepare(job, connection, storageState);
    try {
      let common = job.courts.filter(c => prepared.available.every(list => list.includes(c)));
      if (!job.allowSwitch && !common.length) throw message('No single permitted court is selectable for both hours.');
      const tested = [];
      for (let index = 0; index < 2; index++) {
        const page = prepared.pages[index];
        const candidates = job.allowSwitch ? prepared.available[index] : common;
        let selected;
        for (const court of candidates) {
          try {
            await this.assertAccount(page, connection.accountLabel,connection.identity);
            await page.evaluate(async ({date,hour,court}) => {
              await CourtAdapter.open(date, hour, court);
              const details = CourtAdapter.details();
              CourtAdapter.verify(details,date,hour,court);
              if (details.already || details.success || details.waiting) throw Error('This session already has a booking or pending result.');
              await CourtAdapter.closeModal();
            }, {date:job.date,hour:job.start+index,court});
            selected = court; break;
          } catch { await page.evaluate(() => CourtAdapter.closeModal()).catch(() => {}); }
        }
        if (!selected) throw message('The read-only test could not validate a permitted free session. Check membership, date and account on the official site.');
        if (!job.allowSwitch) common = [selected];
        tested.push({ hour:job.start+index, court:selected });
      }
      return { accountLabel:connection.accountLabel, tested, summary:'Both hourly dialogs were checked without submitting a reservation.' };
    } finally { await this.closePrepared(prepared); }
  }
  async readyCandidate(prepared, job, index, court) {
    const page = prepared.pages[index];
    await this.assertAccount(page, prepared.accountLabel,prepared.identity);
    await page.evaluate(async ({date,hour,court}) => {
      await CourtAdapter.closeModal();
      await CourtAdapter.open(date,hour,court);
      await CourtAdapter.waitBookable(date,hour,court,{timeout:12000,retryReleaseWarning:true});
    }, {date:job.date,hour:job.start+index,court});
  }
  async submit(prepared, job, index, court, beforeClick = async () => {}) {
    if (!this.config.liveEnabled || this.config.mode !== 'live') throw message('Live booking is disabled on this host.');
    if(!prepared.identity?.verified||prepared.identity.kind!=='configured_dom_identity')throw message('A stable provider account identity must be verified before live booking.');
    const page = prepared.pages[index];
    await this.assertAccount(page, prepared.accountLabel,prepared.identity);
    await beforeClick();
    await page.evaluate(({date,hour,court}) => CourtAdapter.submit(date,hour,court), {date:job.date,hour:job.start+index,court});
    // UI success is recorded as UI evidence. Unknown outcomes are never guessed from absence.
    const result = await page.evaluate(() => CourtAdapter.outcome());
    return {status:result.kind === 'confirmed' ? 'confirmed' : result.kind === 'rejected' ? 'rejected' : 'unknown', evidence:result.kind === 'confirmed' ? 'official_booking_success' : null};
  }
  async closePrepared(prepared) {
    if (!prepared || prepared.closed) return;
    prepared.closed = true;
    await prepared.context.close().catch(() => {});
  }
  async close() {
    await Promise.allSettled([...this.contexts].map(c => c.close()));
    if (this.browserPromise) await (await this.browserPromise.catch(() => null))?.close().catch(() => {});
    this.browserPromise = null;
  }
}
