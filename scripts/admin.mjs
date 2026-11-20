import { loadConfig } from '../src/config.mjs';
import { Repository } from '../src/repository.mjs';

const [command,...args]=process.argv.slice(2);
function option(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
if(!['create-invite','list-users','stats'].includes(command)){
  console.log('Usage: node --env-file-if-exists=.env scripts/admin.mjs create-invite [--name "recipient label"] [--hours 48]');
  console.log('       node --env-file-if-exists=.env scripts/admin.mjs list-users | stats');
  process.exitCode=1;
}else{
  let repository;
  try{
    const config=loadConfig();repository=new Repository(config);
    if(command==='create-invite'){
      const hours=Number(option('--hours','48'));
      if(!Number.isFinite(hours)||hours<1||hours>168)throw Error('Hours must be 1–168.');
      const code=repository.createInvite(option('--name',''),hours*3600000);
      console.log(`One-use invitation (expires in ${hours} hours): ${code}`);
      console.log('Share this invitation privately with its intended recipient. It is not a password or booking session.');
    }else if(command==='list-users')console.table(repository.listUsers());
    else console.log(JSON.stringify(repository.stats(),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{repository?.close();}
}
