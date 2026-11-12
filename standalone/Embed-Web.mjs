import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const files = [['INDEX_HTML','index.html'],['STYLE_CSS','style.css'],['APP_JS','app.js']];
const sources = files.map(([,file])=>readFileSync(new URL('./web/'+file,import.meta.url),'utf8'));
const version=createHash('sha256').update(sources.join('\0')).digest('hex').slice(0,16);
const chunks = ['#pragma once','static const char WEB_VERSION[] = "'+version+'";'];
for (const [[name], source] of files.map((file,index)=>[file,sources[index]])) {
  const text = source.replaceAll('__FIELD_LINK_BUILD__',version);
  if(text.includes(')FL_ASSET"'))throw Error('Unexpected firmware string delimiter.');
  chunks.push('static const char '+name+'[] = R"FL_ASSET('+text+')FL_ASSET";',
    'static const unsigned '+name+'_LEN = sizeof('+name+')-1;');
}
writeFileSync(new URL('./firmware/FieldLinkHub/WebAssets.h',import.meta.url),chunks.join('\n')+'\n');
