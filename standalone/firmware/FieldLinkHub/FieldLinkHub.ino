#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <esp_https_server.h>
#include <esp_random.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <cJSON.h>
#include <mbedtls/sha256.h>
#include <vector>
#include <algorithm>
#include <utility>
#include "WebAssets.h"

// All room state is touched by the single HTTPS task. USB provision/restart
// is deliberately separate. No USB or laptop is required after provisioning.
constexpr size_t SEATS=8, MAX_TEXT=900, MAX_BODY=10500, EVENT_BUDGET=23000;
constexpr uint32_t ONLINE_MS=32000, RING_MS=48000;
constexpr size_t MAX_PHOTO=100*1024, PHOTO_SLOTS=5, HISTORY_SEGMENT=3072;
Preferences cfg,accounts;
String ssid,wifiKey,tlsCert,tlsKey,memberCode,operatorCode;
String hubName="fieldlink.local", currentIp, usbInput;
const IPAddress hotspotIp(192,168,4,1);
bool hotspotActive=false;
httpd_handle_t https=nullptr;
uint32_t nextSeq=0, nextMessage=0, bootTag=0, nextPhoto=0;
size_t eventBytes=0;
struct Account { String id,name,hash; bool op=false; uint32_t seen=0,window=0; uint16_t hits=0; };
Account users[SEATS];
struct Event {
  uint32_t seq;
  String who,data,sdp;
  size_t bytes() const { return data.length()+sdp.length(); }
};
std::vector<Event> events;
struct Call { String id,from,to,mode,state; uint32_t at=0,connected=0; bool fromReady=false,toReady=false; String merge; };
std::vector<Call> calls;
struct Receipt { uint32_t id; String from,to; bool photo; uint8_t status=1; };
std::vector<Receipt> receipts;
struct Gate { uint32_t start=0; uint8_t count=0; };
Gate joins;
struct Photo { String id,from,to; uint32_t order; };
std::vector<Photo> photos;
Gate photoWrites;
bool photoStorage=false;
struct LocationFix { double lat=0,lon=0,accuracy=0; uint32_t at=0; };
LocationFix locations[SEATS];
uint8_t locationGrants[SEATS]={};

String randomHex(size_t bytes){
  const char *chars="0123456789abcdef";
  uint8_t values[32]; if(bytes>sizeof(values))return "";
  esp_fill_random(values,bytes); String out;out.reserve(bytes*2);
  for(size_t i=0;i<bytes;i++){out+=chars[values[i]>>4];out+=chars[values[i]&15];}
  return out;
}
String sha(const String& input){
  uint8_t out[32]; mbedtls_sha256((const unsigned char*)input.c_str(),input.length(),out,0);
  const char *hex="0123456789abcdef"; String result;result.reserve(64);
  for(uint8_t b:out){result+=hex[b>>4];result+=hex[b&15];} return result;
}
bool equalFixed(const String& a,const String& b){
  if(a.length()!=b.length())return false; uint8_t diff=0;
  for(size_t i=0;i<a.length();i++)diff|=a[i]^b[i];
  return diff==0;
}
bool validHex(const String& value,size_t count){
  if(value.length()!=count)return false;
  for(size_t i=0;i<value.length();i++)if(!isHexadecimalDigit(value[i]))return false;
  return true;
}
bool validHotspotPassword(const String& password){
  if(password.length()<8||password.length()>63)return false;
  for(size_t i=0;i<password.length();i++)if(password[i]<0x20||password[i]>0x7e)return false;
  return true;
}
String prop(const cJSON* json,const char* key){
  const cJSON *value=cJSON_GetObjectItemCaseSensitive(json,key);
  return cJSON_IsString(value)&&value->valuestring?String(value->valuestring):String();
}
void str(cJSON* j,const char* key,const String& value){cJSON_AddStringToObject(j,key,value.c_str());}
uint32_t integer(const cJSON* j,const char* key){
  const auto *v=cJSON_GetObjectItemCaseSensitive(j,key);
  return cJSON_IsNumber(v)&&v->valuedouble>=0&&v->valuedouble<=4294967295.0?(uint32_t)v->valuedouble:0;
}
bool online(const Account& u){return u.id.length()&&u.seen&&millis()-u.seen<ONLINE_MS;}
Account* findUser(const String& id){for(auto& u:users)if(u.id.length()&&u.id==id)return &u;return nullptr;}
bool isOnline(const String& id){auto *u=findUser(id);return u&&online(*u);}
bool active(const Call& c){return c.state=="ringing"||c.state=="connecting"||c.state=="connected";}
bool validName(const String& name){
  if(!name.length()||name.length()>24||!isAlphaNumeric(name[0]))return false;
  for(size_t i=0;i<name.length();i++){char c=name[i];if(!isAlphaNumeric(c)&&c!=' '&&c!='-'&&c!='_'&&c!='.')return false;}
  return true;
}
void saveUser(Account& a){
  const unsigned idx=&a-users;String k="u"+String(idx);
  auto *j=cJSON_CreateObject();str(j,"id",a.id);str(j,"name",a.name);str(j,"hash",a.hash);cJSON_AddBoolToObject(j,"op",a.op);
  char *raw=cJSON_PrintUnformatted(j);if(raw){accounts.putString(k.c_str(),raw);cJSON_free(raw);}cJSON_Delete(j);
}
void loadUsers(){
  for(unsigned i=0;i<SEATS;i++){
    const String k="u"+String(i), v=accounts.getString(k.c_str());
    auto* j=cJSON_Parse(v.c_str());if(!j)continue;
    Account& a=users[i];a.id=prop(j,"id");a.name=prop(j,"name");a.hash=prop(j,"hash");
    a.op=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j,"op"));cJSON_Delete(j);
    if(!validHex(a.id,16)||!validHex(a.hash,64)||!validName(a.name))a=Account();
  }
}
bool event(const String& to,cJSON* j,const char* sdp=nullptr){
  if(!cJSON_AddNumberToObject(j,"seq",nextSeq+1)){cJSON_Delete(j);return false;}
  char *raw=cJSON_PrintUnformatted(j);cJSON_Delete(j);if(!raw)return false;
  Event queued{nextSeq+1,to,String(raw),String(sdp?sdp:"")};cJSON_free(raw);
  if(queued.who!=to||!queued.data.length()||(sdp&&queued.sdp.length()!=strlen(sdp))||queued.bytes()>EVENT_BUDGET)return false;
  while(!events.empty()&&(eventBytes+queued.bytes()>EVENT_BUDGET||events.size()>=32)){
    eventBytes-=events.front().bytes();events.erase(events.begin());
  }
  ++nextSeq;eventBytes+=queued.bytes();events.push_back(std::move(queued));return true;
}
cJSON* item(const char* kind,const Account& from);
String chatPath(const String& a,const String& b){
  return a<b?"/hx-"+a+b:"/hx-"+b+a;
}
bool saveHistory(const Account& from,const Account& to,const String& content,bool photo,uint32_t id){
  if(!photoStorage)return false;
  auto* row=item(photo?"photo":"text",from);
  str(row,"to",to.id);str(row,photo?"photoId":"text",content);
  cJSON_AddNumberToObject(row,"messageId",id);cJSON_AddNumberToObject(row,"messageBoot",bootTag);
  char* json=cJSON_PrintUnformatted(row);cJSON_Delete(row);if(!json)return false;
  const String path=chatPath(from.id,to.id),older=path+".old";
  File file=LittleFS.open(path,FILE_APPEND);
  const size_t length=strlen(json);
  if(file&&file.size()+length+2>HISTORY_SEGMENT){
    file.close();LittleFS.remove(older);
    if(LittleFS.rename(path,older))file=LittleFS.open(path,FILE_APPEND);
  }
  bool ok=false;
  if(file){ok=file.write('\n')==1&&file.write((const uint8_t*)json,length)==length&&file.write('\n')==1;file.close();}
  cJSON_free(json);return ok;
}
bool publishMessage(const Account& from,const Account& to,const String& content,bool photo){
  const uint32_t id=++nextMessage;
  if(!saveHistory(from,to,content,photo,id))return false;
  for(const Account* recipient:{&to,&from}){
    auto* j=item(photo?"photo":"text",from);
    str(j,"to",to.id);str(j,photo?"photoId":"text",content);
    cJSON_AddBoolToObject(j,"mine",recipient==&from);
    cJSON_AddNumberToObject(j,"messageId",id);
    cJSON_AddNumberToObject(j,"messageBoot",bootTag);
    event(recipient->id,j);
  }
  if(receipts.size()>=32)receipts.erase(receipts.begin());
  receipts.push_back({id,from.id,to.id,photo});
  return true;
}
cJSON* item(const char* kind,const Account& from){
  auto* j=cJSON_CreateObject();cJSON_AddStringToObject(j,"kind",kind);
  str(j,"from",from.id);str(j,"name",from.name);return j;
}
void endCall(Call& c,const char* state,const String& reason){
  if(!active(c))return;
  c.state=state;c.at=millis();
  for(const String* to:{&c.from,&c.to}){
    auto* j=cJSON_CreateObject();cJSON_AddStringToObject(j,"kind","end");str(j,"id",c.id);
    str(j,"state",c.state);str(j,"reason",reason);event(*to,j);
  }
}
void sweep(){
  const auto now=millis();
  for(unsigned i=0;i<SEATS;i++)if(locations[i].at&&now-locations[i].at>25000){locations[i]={};locationGrants[i]=0;}
  for(auto& c:calls){
    if(active(c)&&(!isOnline(c.from)||!isOnline(c.to)))endCall(c,"failed","Device went offline");
    else if(active(c)&&c.state!="connected"&&now-c.at>RING_MS)endCall(c,"ended","No answer");
    if(active(c)&&c.merge.length()&&!std::any_of(calls.begin(),calls.end(),[&](const Call& root){return root.id==c.merge&&active(root);}))
      endCall(c,"ended","The conference host left");
  }
  while(calls.size()>10){
    auto oldest=std::find_if(calls.begin(),calls.end(),[](const Call& c){return !active(c);});
    if(oldest==calls.end())break;
    calls.erase(oldest);
  }
}
String header(httpd_req_t* r,const char* key,size_t max){
  size_t len=httpd_req_get_hdr_value_len(r,key);if(!len||len>max)return "";
  char buffer[130];if(len>=sizeof(buffer))return "";
  if(httpd_req_get_hdr_value_str(r,key,buffer,sizeof(buffer))!=ESP_OK)return "";
  return String(buffer);
}
bool allowedHost(const String& host){return host==currentIp||host==hubName;}
void safeHeaders(httpd_req_t* r){
  httpd_resp_set_hdr(r,"Cache-Control","no-store");
  httpd_resp_set_hdr(r,"X-Content-Type-Options","nosniff");
  httpd_resp_set_hdr(r,"Referrer-Policy","no-referrer");
  httpd_resp_set_hdr(r,"Permissions-Policy","microphone=(self), camera=(self), geolocation=(self)");
  httpd_resp_set_hdr(r,"Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
esp_err_t sendJson(httpd_req_t* r,cJSON* j,const char* status="200 OK"){
  safeHeaders(r);httpd_resp_set_status(r,status);httpd_resp_set_type(r,"application/json");
  char *text=cJSON_PrintUnformatted(j);cJSON_Delete(j);
  if(!text){
    httpd_resp_set_status(r,"503 Service Unavailable");
    return httpd_resp_sendstr(r,"{\"error\":\"Hub busy; retry shortly.\"}");
  }
  const esp_err_t result=httpd_resp_sendstr(r,text);
  if(text)cJSON_free(text);return result;
}
esp_err_t error(httpd_req_t* r,const char* status,const char* message){
  auto* j=cJSON_CreateObject();cJSON_AddStringToObject(j,"error",message);return sendJson(r,j,status);
}
esp_err_t chatHistory(httpd_req_t* r,const Account& a,const Account& b){
  if(!photoStorage)return error(r,"503 Service Unavailable","History storage unavailable.");
  safeHeaders(r);httpd_resp_set_type(r,"application/json");
  if(httpd_resp_sendstr_chunk(r,"{\"messages\":[")!=ESP_OK)return ESP_FAIL;
  const auto path=chatPath(a.id,b.id);const String segments[]={path+".old",path};bool comma=false;
  for(const auto& name:segments){
    File file=LittleFS.open(name,FILE_READ);if(!file)continue;
    while(file.available()){
      const String line=file.readStringUntil('\n');if(!line.length())continue;
      auto* parsed=cJSON_ParseWithOpts(line.c_str(),nullptr,true);if(!parsed)continue;cJSON_Delete(parsed);
      if((comma&&httpd_resp_sendstr_chunk(r,",")!=ESP_OK)||httpd_resp_sendstr_chunk(r,line.c_str())!=ESP_OK){file.close();return ESP_FAIL;}
      comma=true;
    }
    file.close();
  }
  if(httpd_resp_sendstr_chunk(r,"]}")!=ESP_OK)return ESP_FAIL;
  return httpd_resp_send_chunk(r,nullptr,0);
}
cJSON* publicUser(const Account& a){
  auto* j=cJSON_CreateObject();str(j,"id",a.id);str(j,"name",a.name);
  cJSON_AddStringToObject(j,"role",a.op?"operator":"member");cJSON_AddBoolToObject(j,"online",online(a));return j;
}
Account* authenticate(const String& auth){
  if(!auth.startsWith("Bearer "))return nullptr;String key=auth.substring(7);
  if(!validHex(key,64))return nullptr;const auto hash=sha(key);
  for(auto& a:users)if(a.id.length()&&equalFixed(a.hash,hash))return &a;
  return nullptr;
}
bool rated(Account& a){
  const auto now=millis();if(now-a.window>10000){a.window=now;a.hits=0;}return ++a.hits<=24;
}
void acknowledge(const cJSON* request,const char* key,const Account& recipient,uint8_t status){
  const auto* ids=cJSON_GetObjectItemCaseSensitive(request,key);
  if(!cJSON_IsArray(ids)||cJSON_GetArraySize(ids)>16)return;
  const cJSON* id;
  cJSON_ArrayForEach(id,ids){
    if(!cJSON_IsNumber(id)||id->valuedouble<1||id->valuedouble>UINT32_MAX)continue;
    const uint32_t seq=static_cast<uint32_t>(id->valuedouble);
    if(seq!=id->valuedouble)continue;
    for(auto& message:receipts)if(message.id==seq&&message.to==recipient.id&&message.status<status)message.status=status;
  }
}
const char* sessionDescription(const cJSON* json){
  const char* value=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(json,"sdp"));
  return value&&strncmp(value,"v=0",3)==0&&strlen(value)<=9000?value:nullptr;
}
esp_err_t sendEvent(httpd_req_t* r,const Event& e){
  if(!e.sdp.length())return httpd_resp_sendstr_chunk(r,e.data.c_str());
  if(httpd_resp_send_chunk(r,e.data.c_str(),e.data.length()-1)!=ESP_OK||
     httpd_resp_sendstr_chunk(r,",\"sdp\":\"")!=ESP_OK)return ESP_FAIL;
  char chunk[768];size_t used=0;
  const char* hex="0123456789abcdef";
  for(size_t i=0;i<e.sdp.length();++i){
    const uint8_t byte=e.sdp[i];
    if(byte=='\r'||byte=='\n'||byte=='\t'){
      chunk[used++]='\\';chunk[used++]=byte=='\r'?'r':byte=='\n'?'n':'t';
    }else if(byte<32){
      const char escaped[]={'\\','u','0','0',hex[byte>>4],hex[byte&15]};
      memcpy(chunk+used,escaped,sizeof(escaped));used+=sizeof(escaped);
    }else{
      if(byte=='"'||byte=='\\')chunk[used++]='\\';
      chunk[used++]=byte;
    }
    if(used>sizeof(chunk)-6){if(httpd_resp_send_chunk(r,chunk,used)!=ESP_OK)return ESP_FAIL;used=0;}
  }
  if(used&&httpd_resp_send_chunk(r,chunk,used)!=ESP_OK)return ESP_FAIL;
  return httpd_resp_sendstr_chunk(r,"\"}");
}
bool callId(const String& s){
  if(s.length()!=36)return false;
  for(unsigned i=0;i<36;i++){const bool dash=i==8||i==13||i==18||i==23;if(dash?s[i]!='-':!isHexadecimalDigit(s[i]))return false;}
  return true;
}
esp_err_t actions(httpd_req_t* r,const cJSON* d){
  String action=prop(d,"action");sweep();
  if(action=="join"){
    const uint32_t now=millis();
    if(now-joins.start>60000){joins.start=now;joins.count=0;}
    if(joins.count>=12)return error(r,"429 Too Many Requests","Wait a minute before trying another invite.");
    joins.count++;
    const String code=prop(d,"code");const bool op=equalFixed(code,operatorCode);
    if(!op&&!equalFixed(code,memberCode))return error(r,"401 Unauthorized","Invalid room code.");
    String name=prop(d,"name");name.trim();
    if(!validName(name))return error(r,"400 Bad Request","Choose 1–24 letters, digits or simple separators.");
    Account* seat=nullptr;
    for(auto& u:users){
      if(u.id.length()&&u.name.equalsIgnoreCase(name))return error(r,"409 Conflict","That name is already registered.");
      if(!u.id.length()&&!seat)seat=&u;
    }
    if(!seat)return error(r,"409 Conflict","All eight room seats are registered.");
    const String token=randomHex(32);seat->id=randomHex(8);seat->name=name;seat->hash=sha(token);seat->op=op;seat->seen=now;
    saveUser(*seat);
    auto* out=cJSON_CreateObject();str(out,"token",token);cJSON_AddItemToObject(out,"me",publicUser(*seat));
    cJSON_AddNumberToObject(out,"boot",bootTag);return sendJson(r,out);
  }
  Account* p=authenticate(header(r,"Authorization",85));
  if(!p)return error(r,"401 Unauthorized","Join this room again.");
  if(!rated(*p))return error(r,"429 Too Many Requests","Slow down and retry.");
  p->seen=millis();
  if(action=="resume"){
    auto* out=cJSON_CreateObject();cJSON_AddItemToObject(out,"me",publicUser(*p));cJSON_AddNumberToObject(out,"boot",bootTag);return sendJson(r,out);
  }
  if(action=="leave"){
    const String id=p->id;
    for(auto& c:calls)if(c.from==id||c.to==id)endCall(c,"ended","");
    for(auto it=events.begin();it!=events.end();){if(it->who==id){eventBytes-=it->bytes();it=events.erase(it);}else ++it;}
    const unsigned idx=p-users;
    for(const auto& u:users)if(u.id.length()&&u.id!=id){const auto path=chatPath(id,u.id);LittleFS.remove(path);LittleFS.remove(path+".old");}
    locations[idx]={};locationGrants[idx]=0;for(auto& grants:locationGrants)grants&=~(1u<<idx);
    accounts.remove(("u"+String(idx)).c_str());*p=Account();
    return sendJson(r,cJSON_CreateObject());
  }
  if(action=="history"){
    auto* other=findUser(prop(d,"peer"));if(!other||other==p)return error(r,"404 Not Found","Conversation unavailable.");
    return chatHistory(r,*p,*other);
  }
  if(action=="location"){
    const unsigned idx=p-users;
    if(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(d,"stop"))){locations[idx]={};locationGrants[idx]=0;}
    else{
      const auto *lat=cJSON_GetObjectItemCaseSensitive(d,"lat"),*lon=cJSON_GetObjectItemCaseSensitive(d,"lon"),*acc=cJSON_GetObjectItemCaseSensitive(d,"accuracy");
      if(!cJSON_IsNumber(lat)||!cJSON_IsNumber(lon)||!cJSON_IsNumber(acc)||lat->valuedouble < -90||lat->valuedouble>90||lon->valuedouble < -180||lon->valuedouble>180||acc->valuedouble<0||acc->valuedouble>100000)
        return error(r,"400 Bad Request","Invalid position.");
      locations[idx]={lat->valuedouble,lon->valuedouble,acc->valuedouble,millis()};
    }
    return sendJson(r,cJSON_CreateObject());
  }
  if(action=="locationGrant"){
    if(!p->op)return error(r,"403 Forbidden","Operator access required.");
    auto* subject=findUser(prop(d,"subject"));auto* viewer=findUser(prop(d,"viewer"));
    if(!subject||!viewer||subject==viewer)return error(r,"400 Bad Request","Choose two different members.");
    auto& mask=locationGrants[subject-users];const unsigned bit=1u<<(viewer-users);
    if(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(d,"allow"))){
      const auto& fix=locations[subject-users];if(!fix.at||millis()-fix.at>25000)return error(r,"409 Conflict","The member is not sharing a fresh position.");
      mask|=bit;
    }else mask&=~bit;
    return sendJson(r,cJSON_CreateObject());
  }
  if(action=="poll"||action=="watch"){
    const bool watch=action=="watch";const auto clientBoot=integer(d,"boot");
    const auto cursor=clientBoot&&clientBoot!=bootTag?0:integer(d,"cursor");
    auto *out=cJSON_CreateObject();
    cJSON_AddNumberToObject(out,"boot",bootTag);
    if(!watch){
      if(clientBoot==bootTag){acknowledge(d,"delivered",*p,2);acknowledge(d,"read",*p,3);}
      auto* peers=cJSON_AddArrayToObject(out,"peers");for(auto& u:users)if(u.id.length() && &u!=p)cJSON_AddItemToArray(peers,publicUser(u));
      auto* delivery=cJSON_AddArrayToObject(out,"receipts");
      for(const auto& message:receipts)if(message.from==p->id&&message.status>1){
        auto* row=cJSON_CreateArray();cJSON_AddItemToArray(delivery,row);
        cJSON_AddItemToArray(row,cJSON_CreateNumber(message.id));cJSON_AddItemToArray(row,cJSON_CreateNumber(message.status));
      }
      auto* list=cJSON_AddArrayToObject(out,"calls");
      for(auto& c:calls)if(p->op||c.from==p->id||c.to==p->id){
        auto* j=cJSON_CreateObject();str(j,"id",c.id);str(j,"from",c.from);str(j,"to",c.to);str(j,"state",c.state);str(j,"mode",c.mode);
        auto* f=findUser(c.from);auto* t=findUser(c.to);str(j,"fromName",f?f->name:"Offline");str(j,"toName",t?t->name:"Offline");cJSON_AddItemToArray(list,j);
        if(c.connected)cJSON_AddNumberToObject(j,"duration",((active(c)?millis():c.at)-c.connected)/1000);
        if(c.merge.length())str(j,"merge",c.merge);
      }
      cJSON_AddNumberToObject(out,"heap",ESP.getFreeHeap());
      if(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(d,"tracking"))){
        auto* fixes=cJSON_AddArrayToObject(out,"locations");
        auto* grants=(p->op?cJSON_AddArrayToObject(out,"locationGrants"):nullptr);
        for(unsigned i=0;i<SEATS;i++){
          const auto& fix=locations[i];if(!users[i].id.length()||!fix.at||millis()-fix.at>25000)continue;
          if(p->op||&users[i]==p||(locationGrants[i]&(1u<<(p-users)))){
            auto* row=cJSON_CreateObject();cJSON_AddItemToArray(fixes,row);str(row,"id",users[i].id);str(row,"name",users[i].name);
            cJSON_AddNumberToObject(row,"lat",fix.lat);cJSON_AddNumberToObject(row,"lon",fix.lon);cJSON_AddNumberToObject(row,"accuracy",fix.accuracy);
            cJSON_AddNumberToObject(row,"age",(millis()-fix.at)/1000);
          }
          if(grants)for(unsigned j=0;j<SEATS;j++)if((locationGrants[i]&(1u<<j))&&users[j].id.length()){
            auto* row=cJSON_CreateArray();cJSON_AddItemToArray(grants,row);cJSON_AddItemToArray(row,cJSON_CreateString(users[i].name.c_str()));cJSON_AddItemToArray(row,cJSON_CreateString(users[j].name.c_str()));
          }
        }
      }
      if(p->op){
        auto* dashboard=cJSON_AddObjectToObject(out,"operator");
        cJSON_AddNumberToObject(dashboard,"uptime",millis()/1000);
        cJSON_AddNumberToObject(dashboard,"resetReason",esp_reset_reason());
        auto* activity=cJSON_AddArrayToObject(dashboard,"activity");
        for(size_t i=receipts.size();i>0&&receipts.size()-i<12;--i){
          const auto& message=receipts[i-1];auto* row=cJSON_CreateObject();cJSON_AddItemToArray(activity,row);
          auto* from=findUser(message.from);auto* to=findUser(message.to);
          str(row,"from",from?from->name:"Former member");str(row,"to",to?to->name:"Former member");
          cJSON_AddBoolToObject(row,"photo",message.photo);cJSON_AddNumberToObject(row,"status",message.status);
        }
      }
    }
    char *metadata=cJSON_PrintUnformatted(out);cJSON_Delete(out);
    if(!metadata)return error(r,"503 Service Unavailable","Hub busy; retry shortly.");
    safeHeaders(r);httpd_resp_set_type(r,"application/json");
    auto result=httpd_resp_send_chunk(r,metadata,strlen(metadata)-1);cJSON_free(metadata);
    if(result!=ESP_OK||httpd_resp_sendstr_chunk(r,",\"events\":[")!=ESP_OK)return ESP_FAIL;
    unsigned count=0;size_t payload=0;
    for(const auto& e:events){
      if(e.who!=p->id||e.seq<=cursor)continue;
      if(!watch&&payload&&payload+e.bytes()>10000)break;
      char *reduced=nullptr;
      if(watch){
        auto* j=cJSON_Parse(e.data.c_str());if(!j)return ESP_FAIL;
        if(prop(j,"kind")=="offer"){
          const auto id=prop(j,"id");
          cJSON_AddBoolToObject(j,"live",std::any_of(calls.begin(),calls.end(),[&](const Call& c){return c.id==id&&c.state=="ringing";}));
        }
        cJSON_DeleteItemFromObject(j,"sdp");cJSON_DeleteItemFromObject(j,"text");
        reduced=cJSON_PrintUnformatted(j);cJSON_Delete(j);if(!reduced)return ESP_FAIL;
      }
      result=count?httpd_resp_sendstr_chunk(r,","):ESP_OK;
      if(result==ESP_OK)result=watch?httpd_resp_sendstr_chunk(r,reduced):sendEvent(r,e);
      if(reduced)cJSON_free(reduced);
      if(result!=ESP_OK)return ESP_FAIL;
      payload+=e.bytes();if(++count>=3)break;
    }
    if(httpd_resp_sendstr_chunk(r,"]}")!=ESP_OK)return ESP_FAIL;
    return httpd_resp_send_chunk(r,nullptr,0);
  }
  if(action=="text"){
    const auto who=prop(d,"to"), text=prop(d,"text");auto* to=findUser(who);
    if(!to||to==p)return error(r,"404 Not Found","Choose a room member.");
    if(!text.length()||text.length()>MAX_TEXT)return error(r,"400 Bad Request","Message must be 1–900 UTF-8 bytes.");
    if(!publishMessage(*p,*to,text,false))return error(r,"503 Service Unavailable","Hub busy; retry the message shortly.");
    return sendJson(r,cJSON_CreateObject());
  }
  if(action=="call"){
    const auto signal=prop(d,"signal"), id=prop(d,"id");
    if(!callId(id))return error(r,"400 Bad Request","Invalid call ID.");
    auto it=std::find_if(calls.begin(),calls.end(),[&](const Call& c){return c.id==id;});
    if(signal=="offer"){
      const auto who=prop(d,"to"),mode=prop(d,"mode"),merge=prop(d,"merge");const char* sdp=sessionDescription(d);
      if(!isOnline(who)||who==p->id)return error(r,"409 Conflict","Recipient is offline.");
      if(merge.length()&&(mode!="voice"||!std::any_of(calls.begin(),calls.end(),[&](const Call& c){
        return c.id==merge&&c.mode=="voice"&&c.state=="connected"&&!c.merge.length()&&(c.from==p->id||c.to==p->id);
      })))return error(r,"409 Conflict","An active voice call is required to merge.");
      if(it!=calls.end()||std::any_of(calls.begin(),calls.end(),[&](const Call& c){
        return active(c)&&(c.from==who||c.to==who||((c.from==p->id||c.to==p->id)&&c.id!=merge));
      }))
        return error(r,"409 Conflict","A participant is already in a call.");
      if(!sdp||(mode!="voice"&&mode!="video"))return error(r,"400 Bad Request","Invalid session offer.");
      auto* j=item("offer",*p);str(j,"id",id);str(j,"mode",mode);if(merge.length())cJSON_AddBoolToObject(j,"conference",true);
      if(!event(who,j,sdp))return error(r,"503 Service Unavailable","Hub busy; retry the call shortly.");
      calls.push_back({id,p->id,who,mode,"ringing",millis()});
      calls.back().merge=merge;
      return sendJson(r,cJSON_CreateObject());
    }
    if(it==calls.end()||(it->from!=p->id&&it->to!=p->id))return error(r,"404 Not Found","Call not found.");
    auto& c=*it;if(!active(c))return sendJson(r,cJSON_CreateObject());
    if(signal=="answer"){
      const char* sdp=sessionDescription(d);
      if(c.to!=p->id||c.state!="ringing"||!sdp)return error(r,"409 Conflict","Cannot answer this session.");
      auto* j=item("answer",*p);str(j,"id",id);
      if(!event(c.from,j,sdp))return error(r,"503 Service Unavailable","Hub busy; retry the call shortly.");
      c.state="connecting";c.at=millis();
    }else if(signal=="ready"){
      if(c.state=="ringing")return error(r,"409 Conflict","The session is not answered.");
      if(c.from==p->id)c.fromReady=true;else c.toReady=true;
      if(c.fromReady&&c.toReady&&c.state!="connected"){c.state="connected";c.connected=millis();}
    }else if(signal=="decline"&&c.to==p->id&&c.state=="ringing")endCall(c,"declined","");
    else if(signal=="end"||signal=="failed")endCall(c,signal=="end"?"ended":"failed","");
    else return error(r,"400 Bad Request","Unknown call action.");
    return sendJson(r,cJSON_CreateObject());
  }
  return error(r,"404 Not Found","Unknown action.");
}
esp_err_t api(httpd_req_t* r){
  const auto host=header(r,"Host",64),origin=header(r,"Origin",110),content=header(r,"Content-Type",80);
  if(!allowedHost(host)||origin!="https://"+host||content!="application/json")
    return error(r,"403 Forbidden","Same-origin HTTPS JSON is required.");
  if(!r->content_len||r->content_len>MAX_BODY)return error(r,"413 Payload Too Large","Request is too large.");
  const size_t length=r->content_len;char *body=(char*)malloc(length+1);
  if(!body)return error(r,"503 Service Unavailable","Hub busy; retry shortly.");
  size_t total=0;while(total<length){
    const int count=httpd_req_recv(r,body+total,length-total);
    if(count<=0){free(body);return ESP_FAIL;}total+=count;
  }
  body[length]=0;auto* d=cJSON_ParseWithOpts(body,nullptr,true);free(body);
  if(!cJSON_IsObject(d)){if(d)cJSON_Delete(d);return error(r,"400 Bad Request","Invalid JSON.");}
  auto ret=actions(r,d);cJSON_Delete(d);return ret;
}
String photoPath(const String& id){return "/fl-"+id+".jpg";}
String photoInfo(const String& id){return "/fl-"+id+".inf";}
void removePhoto(const String& id){LittleFS.remove(photoPath(id));LittleFS.remove(photoInfo(id));}
bool savePhotoInfo(const Photo& p){
  File f=LittleFS.open(photoInfo(p.id),FILE_WRITE);if(!f)return false;
  const auto record=p.from+p.to+String(p.order);const bool ok=f.print(record)==record.length();f.close();return ok;
}
void loadPhotos(){
  File dir=LittleFS.open("/");if(!dir)return;
  std::vector<String> orphans;
  for(File f=dir.openNextFile();f;f=dir.openNextFile()){
    const String name=f.name(),id=name.substring(3,27);
    if(name.length()==31&&name.startsWith("fl-")&&validHex(id,24)){
      if(name.endsWith(".jpg")&&!LittleFS.exists(photoInfo(id)))orphans.push_back(id);
      if(name.endsWith(".inf")){
        String row;if(f.size()>=33&&f.size()<=42)row=f.readString();
        const String from=row.substring(0,16),to=row.substring(16,32);
        const uint32_t order=strtoul(row.substring(32).c_str(),nullptr,10);
        if(order&&validHex(from,16)&&validHex(to,16)&&LittleFS.exists(photoPath(id))){
          photos.push_back({id,from,to,order});nextPhoto=std::max(nextPhoto,order);
        }else orphans.push_back(id);
      }
    }
    f.close();
  }
  dir.close();for(const auto& id:orphans)removePhoto(id);
  std::sort(photos.begin(),photos.end(),[](const Photo& a,const Photo& b){return a.order<b.order;});
  while(photos.size()>PHOTO_SLOTS){removePhoto(photos.front().id);photos.erase(photos.begin());}
}
bool validJpeg(File& f){
  if(f.size()<24||!f.seek(f.size()-2)||f.read()!=255||f.read()!=217||!f.seek(0)||f.read()!=255||f.read()!=216)return false;
  while(f.position()+5<f.size()&&f.position()<8192){
    if(f.read()!=255)return false;
    int marker;do{marker=f.read();}while(marker==255&&f.position()<8192);
    if(marker<0||marker==255||marker==218||marker==217)return false;
    const int a=f.read(),b=f.read();if(a<0||b<0)return false;
    const size_t len=(a<<8)|b, body=f.position();
    if(len<2||body+len-2>f.size())return false;
    if(marker==192||marker==194){
      if(len<8||f.read()!=8)return false;
      const int a=f.read(),b=f.read(),c=f.read(),d=f.read();if(a<0||b<0||c<0||d<0)return false;
      const int h=(a<<8)|b,w=(c<<8)|d;return h>0&&h<=900&&w>0&&w<=900;
    }
    if(!f.seek(body+len-2))return false;
  }
  return false;
}
esp_err_t photoUpload(httpd_req_t* r){
  const auto host=header(r,"Host",64);
  if(!allowedHost(host)||header(r,"Origin",110)!="https://"+host||header(r,"Content-Type",40)!="image/jpeg")
    return error(r,"403 Forbidden","Same-origin HTTPS JPEG required.");
  Account* p=authenticate(header(r,"Authorization",85));if(!p)return error(r,"401 Unauthorized","Join this room again.");
  if(!rated(*p))return error(r,"429 Too Many Requests","Slow down and retry.");
  Account* to=findUser(header(r,"X-Recipient",24));if(!to||to==p)return error(r,"404 Not Found","Choose a room member.");
  if(!photoStorage)return error(r,"503 Service Unavailable","Photo storage is unavailable.");
  if(r->content_len<24||r->content_len>MAX_PHOTO)return error(r,"413 Payload Too Large","Photo is larger than 100 KB.");
  const uint32_t now=millis();p->seen=now;
  if(now-photoWrites.start>60000){photoWrites.start=now;photoWrites.count=0;}
  if(photoWrites.count>=10)return error(r,"429 Too Many Requests","Wait before sending another photo.");
  photoWrites.count++;
  const String id=randomHex(12),path=photoPath(id);
  File f=LittleFS.open(path,FILE_WRITE);if(!f)return error(r,"503 Service Unavailable","Photo storage is full.");
  size_t remaining=r->content_len;char buffer[1024];const uint32_t deadline=millis()+12000;
  while(remaining){
    if((int32_t)(millis()-deadline)>0){f.close();LittleFS.remove(path);return ESP_FAIL;}
    const int n=httpd_req_recv(r,buffer,std::min(remaining,sizeof(buffer)));
    if(n<=0||f.write((const uint8_t*)buffer,n)!=(size_t)n){f.close();LittleFS.remove(path);return ESP_FAIL;}
    remaining-=n;
  }
  f.close();f=LittleFS.open(path,FILE_READ);
  const bool valid=f&&validJpeg(f);f.close();
  if(!valid){LittleFS.remove(path);return error(r,"400 Bad Request","Invalid or oversized JPEG image.");}
  const Photo photo{id,p->id,to->id,++nextPhoto};
  if(!savePhotoInfo(photo)||!publishMessage(*p,*to,id,true)){removePhoto(id);return error(r,"503 Service Unavailable","Hub busy; retry the photo shortly.");}
  if(photos.size()>=PHOTO_SLOTS){removePhoto(photos.front().id);photos.erase(photos.begin());}
  photos.push_back(photo);
  return sendJson(r,cJSON_CreateObject());
}
esp_err_t photoDownload(httpd_req_t* r){
  if(!allowedHost(header(r,"Host",64)))return error(r,"421 Misdirected Request","Use the hub address.");
  Account* p=authenticate(header(r,"Authorization",85));if(!p)return error(r,"401 Unauthorized","Join this room again.");
  if(!rated(*p))return error(r,"429 Too Many Requests","Slow down and retry.");
  char query[32]={},id[25]={};
  if(httpd_req_get_url_query_str(r,query,sizeof(query))!=ESP_OK||
     httpd_query_key_value(query,"id",id,sizeof(id))!=ESP_OK||!validHex(id,24))return error(r,"404 Not Found","Photo unavailable.");
  auto it=std::find_if(photos.begin(),photos.end(),[&](const Photo& ph){return ph.id==id&&(ph.from==p->id||ph.to==p->id);});
  if(it==photos.end())return error(r,"404 Not Found","Photo unavailable.");
  File f=LittleFS.open(photoPath(it->id),FILE_READ);if(!f)return error(r,"404 Not Found","Photo unavailable.");
  safeHeaders(r);httpd_resp_set_type(r,"image/jpeg");
  char buffer[1024];size_t n;
  while((n=f.readBytes(buffer,sizeof(buffer)))>0)if(httpd_resp_send_chunk(r,buffer,n)!=ESP_OK){f.close();return ESP_FAIL;}
  f.close();return httpd_resp_send_chunk(r,nullptr,0);
}
esp_err_t asset(httpd_req_t* r){
  if(!allowedHost(header(r,"Host",64)))return error(r,"421 Misdirected Request","Use the hub address.");
  const char *uri=r->uri;safeHeaders(r);
  if(strcmp(uri,"/")==0){httpd_resp_set_type(r,"text/html; charset=utf-8");return httpd_resp_send(r,INDEX_HTML,INDEX_HTML_LEN);}
  if(strcmp(uri,"/style.css")==0){httpd_resp_set_type(r,"text/css; charset=utf-8");return httpd_resp_send(r,STYLE_CSS,STYLE_CSS_LEN);}
  if(strcmp(uri,"/app.js")==0){httpd_resp_set_type(r,"text/javascript; charset=utf-8");return httpd_resp_send(r,APP_JS,APP_JS_LEN);}
  if(strcmp(uri,"/version")==0){httpd_resp_set_type(r,"text/plain; charset=utf-8");return httpd_resp_sendstr(r,WEB_VERSION);}
  return error(r,"404 Not Found","Unknown route.");
}
void startHttps(){
  if(https||!tlsCert.length()||!tlsKey.length()||(!hotspotActive&&WiFi.status()!=WL_CONNECTED))return;
  httpd_ssl_config_t settings=HTTPD_SSL_CONFIG_DEFAULT();
  settings.servercert=(const uint8_t*)tlsCert.c_str();settings.servercert_len=tlsCert.length()+1;
  settings.prvtkey_pem=(const uint8_t*)tlsKey.c_str();settings.prvtkey_len=tlsKey.length()+1;
  settings.httpd.max_open_sockets=3;settings.httpd.lru_purge_enable=true;
  settings.httpd.recv_wait_timeout=4;settings.httpd.send_wait_timeout=4;settings.httpd.stack_size=10240;
  if(httpd_ssl_start(&https,&settings)!=ESP_OK){https=nullptr;Serial.println("HTTPS ERROR");return;}
  const httpd_uri_t handlers[]={{"/",HTTP_GET,asset,nullptr},{"/style.css",HTTP_GET,asset,nullptr},{"/app.js",HTTP_GET,asset,nullptr},
    {"/api",HTTP_POST,api,nullptr},{"/photo",HTTP_POST,photoUpload,nullptr},{"/photo",HTTP_GET,photoDownload,nullptr},{"/version",HTTP_GET,asset,nullptr}};
  for(auto& h:handlers)if(httpd_register_uri_handler(https,&h)!=ESP_OK){httpd_ssl_stop(https);https=nullptr;Serial.println("HTTPS ERROR");return;}
  if(MDNS.begin("fieldlink"))MDNS.addService("fieldlink","tcp",443);
  Serial.println("HTTPS READY "+currentIp);
}
bool setCfg(const String& name,const String& value){return cfg.putString(name.c_str(),value)>0;}
bool legacyFixture(const String& name){
  const int dash=name.indexOf('-');if(dash<0||name.length()!=size_t(dash+7))return false;
  const String prefix=name.substring(0,dash);
  if(prefix!="Alpha"&&prefix!="Bravo"&&prefix!="Desk"&&prefix!="Audit")return false;
  for(size_t i=dash+1;i<name.length();++i){const char c=name[i];if(!((c>='0'&&c<='9')||(c>='a'&&c<='z')))return false;}
  return true;
}
void usb(const String& input){
  if(input=="INFO"){
    Serial.println("FLHUB "+(currentIp.length()?currentIp:"-")+" "+(https?String("READY"):String("WAIT")));
    Serial.println("MEMBER "+memberCode);Serial.println("OPERATOR "+operatorCode);return;
  }
  auto* d=cJSON_Parse(input.c_str());if(!cJSON_IsObject(d)){if(d)cJSON_Delete(d);return;}
  const auto action=prop(d,"action");
  if(action=="wifi"){
    const auto name=prop(d,"ssid"),key=prop(d,"password");
    if(name.length()>0&&name.length()<=32&&key.length()>=8&&key.length()<=63&&setCfg("ssid",name)&&setCfg("wifi",key)){
      Serial.println("WIFI SAVED");Serial.flush();delay(150);ESP.restart();
    }else Serial.println("WIFI ERROR");
  }else if(action=="hotspot"){
    const auto key=prop(d,"password");
    if(validHotspotPassword(key)&&setCfg("hotspotKey",key)){
      Serial.println("HOTSPOT SAVED");Serial.flush();delay(150);ESP.restart();
    }else Serial.println("HOTSPOT ERROR");
  }else if(action=="useSavedRouter"){
    if(ssid.length()&&(!cfg.isKey("hotspotKey")||cfg.remove("hotspotKey"))){
      Serial.println("ROUTER MODE SAVED");Serial.flush();delay(150);ESP.restart();
    }else Serial.println("ROUTER MODE ERROR");
  }else if(action=="tls"){
    const auto cert=prop(d,"cert"),key=prop(d,"key");
    if(cert.startsWith("-----BEGIN CERTIFICATE-----")&&key.startsWith("-----BEGIN PRIVATE KEY-----")&&cert.length()<1800&&key.length()<1000&&
      setCfg("cert",cert)&&setCfg("key",key)){Serial.println("TLS SAVED");Serial.flush();delay(150);ESP.restart();}
    else Serial.println("TLS ERROR");
  }else if(action=="clearSeats"){
    accounts.clear();Serial.println("SEATS CLEARED");Serial.flush();delay(150);ESP.restart();
  }else if(action=="cleanLegacyFixtures"){
    if(https){httpd_ssl_stop(https);https=nullptr;}
    unsigned removed=0;
    for(size_t i=0;i<SEATS;++i)if(!online(users[i])&&legacyFixture(users[i].name)&&accounts.remove(("u"+String(i)).c_str())){
      users[i]=Account();++removed;
    }
    Serial.printf("TEST SEATS REMOVED %u\n",removed);
  }
  cJSON_Delete(d);
}
void setup(){
  Serial.begin(115200);cfg.begin("fieldlink",false);accounts.begin("fl-users",false);
  Serial.printf("FLHUB reset_reason=%d\n",int(esp_reset_reason()));
  photoStorage=LittleFS.begin(false,"/flphotos",4,"flphotos");
  if(!photoStorage&&!cfg.getBool("photoFS",false))photoStorage=LittleFS.begin(true,"/flphotos",4,"flphotos");
  if(photoStorage){
    cfg.putBool("photoFS",true);
    loadPhotos();
  }
  bootTag=esp_random()&0x7fffffff;if(!bootTag)bootTag=1;
  memberCode=cfg.getString("member");operatorCode=cfg.getString("operator");
  if(!validHex(memberCode,20)){memberCode=randomHex(10);setCfg("member",memberCode);}
  if(!validHex(operatorCode,24)){operatorCode=randomHex(12);setCfg("operator",operatorCode);}
  loadUsers();ssid=cfg.getString("ssid");wifiKey=cfg.getString("wifi");tlsCert=cfg.getString("cert");tlsKey=cfg.getString("key");
  WiFi.persistent(false);
  const auto hotspotKey=cfg.getString("hotspotKey");
  if(validHotspotPassword(hotspotKey)){
    hotspotActive=WiFi.mode(WIFI_AP)&&WiFi.softAPConfig(hotspotIp,hotspotIp,IPAddress(255,255,255,0))&&
      WiFi.softAP("Field Link",hotspotKey.c_str(),6,0,SEATS);
    if(hotspotActive)Serial.println("HOTSPOT READY Field Link");
    else{WiFi.mode(WIFI_OFF);Serial.println("HOTSPOT ERROR");}
  }else if(ssid.length()){
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(ssid.c_str(),wifiKey.c_str());
  }
  else WiFi.mode(WIFI_OFF);
  Serial.println("FLHUB BOOT");
}
void loop(){
  static bool discard=false;static uint32_t lastAttempt=0;
  while(Serial.available()){
    const char c=char(Serial.read());
    if(c=='\n'){if(!discard&&usbInput.length())usb(usbInput);usbInput="";discard=false;}
    else if(c!='\r'&&!discard){if(usbInput.length()<3100)usbInput+=c;else{usbInput="";discard=true;}}
  }
  if(hotspotActive||WiFi.status()==WL_CONNECTED){
    const String ip=(hotspotActive?WiFi.softAPIP():WiFi.localIP()).toString();
    if(ip!=currentIp){if(https){httpd_ssl_stop(https);https=nullptr;}currentIp=ip;Serial.println("HUB IP "+currentIp);}
    if(!https&&millis()-lastAttempt>3000){lastAttempt=millis();startHttps();}
  }
  delay(15);
}
