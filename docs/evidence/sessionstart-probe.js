const fs=require('fs'),path=require('path');let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>raw+=d);
process.stdin.on('end',()=>{try{fs.appendFileSync(path.join(__dirname,'sessionstart-log.jsonl'),JSON.stringify({at:new Date().toISOString(),stdin_raw:raw})+'\n');}catch(e){}process.exit(0);});
setTimeout(()=>{try{fs.appendFileSync(path.join(__dirname,'sessionstart-log.jsonl'),JSON.stringify({at:new Date().toISOString(),stdin_raw:'(no stdin)'})+'\n');}catch(e){}process.exit(0);},3000);
