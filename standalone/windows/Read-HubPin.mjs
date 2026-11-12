import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';

const config=readFileSync(new URL('../private/hub-access.log',import.meta.url),'utf8');
const match=config.match(/^URL (https:\/\/[\d.]+)\r?$/m);
if(!match)throw Error('Provision the ESP32 first.');
const url=new URL(match[1]);
const ca=new X509Certificate(readFileSync(new URL('../private/field-link-hub-ca.crt',import.meta.url))).toString();
const socket=connect({host:url.hostname,port:443,ca,rejectUnauthorized:true},()=>{
  const leaf=socket.getPeerCertificate().raw;
  if(!leaf){socket.destroy(Error('No hub certificate received.'));return;}
  process.stdout.write(url.origin+'\n'+createHash('sha256').update(leaf).digest('hex')+'\n');
  socket.destroy();
});
socket.setTimeout(7000,()=>socket.destroy(Error('The ESP32 did not answer.')));
