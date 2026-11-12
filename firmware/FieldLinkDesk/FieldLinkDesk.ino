#include <Arduino.h>
#include <WiFi.h>
#include <cstring>

// Use only 3.3 V compatible modules; adjust polarity if necessary.
constexpr int LED_RED=25, LED_GREEN=26, BUZZER=27, ACK_BUTTON=33;
constexpr int BOOT_BUTTON=0;
constexpr int LED_ON=HIGH, BUZZER_ON=HIGH;
constexpr int LED_OFF=LED_ON==HIGH?LOW:HIGH;
constexpr int BUZZER_OFF=BUZZER_ON==HIGH?LOW:HIGH;
// I = idle, L = latched, A = acknowledged. Repeated ALERT IDs are idempotent.
char state='I', active[37]="-", line[64];
size_t length=0;
bool overflow=false, raw=false, stable=false, testing=false;
uint32_t changed=0, started=0, testAt=0;
bool accessPoint=false;
uint32_t apStarted=0;
constexpr uint32_t AP_DURATION=60UL*60UL*1000UL;

void stopAP(bool report){
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  accessPoint=false;
  if(report)Serial.println("AP OFF");
}
void startAP(const char* password){
  if(strlen(password)!=20){Serial.println("AP ERROR");return;}
  for(int i=0;i<20;i++)if(!((password[i]>='0'&&password[i]<='9')||(password[i]>='a'&&password[i]<='f'))){
    Serial.println("AP ERROR");return;
  }
  if(accessPoint)stopAP(false);
  if(!WiFi.mode(WIFI_AP)||!WiFi.softAP("FieldLink-Local",password,6,0,4)){stopAP(false);Serial.println("AP ERROR");return;}
  apStarted=millis();accessPoint=true;Serial.println("AP ON");
}
bool buttonPressed(){return digitalRead(ACK_BUTTON)==LOW||digitalRead(BOOT_BUTTON)==LOW;}

bool validId(const char* id){
  if(strlen(id)!=36)return false;
  for(int i=0;i<36;i++){
    char c=id[i];bool dash=i==8||i==13||i==18||i==23;
    if(dash?c!='-':!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
  }
  return true;
}
void pong(){
  Serial.print("PONG ");Serial.print(active);Serial.print(' ');Serial.println(state);
}
void alert(const char* id,bool retry){
  if(!validId(id))return;
  const bool same=strcmp(id,active)==0;
  if(state=='L'&&!same){Serial.println("ALERT BUSY");return;}
  if(!same||(retry&&state!='L')){
    memcpy(active,id,37);state='L';started=millis();testing=false;
  }
  pong();
}
void command(){
  if(strcmp(line,"PING")==0)pong();
  else if(strcmp(line,"AP?")==0)Serial.println(accessPoint?"AP ON":"AP OFF");
  else if(strcmp(line,"APSTOP")==0)stopAP(true);
  else if(strncmp(line,"APSTART ",8)==0)startAP(line+8);
  else if(strncmp(line,"ALERT ",6)==0)alert(line+6,false);
  else if(strncmp(line,"RETRY ",6)==0)alert(line+6,true);
  else if(strcmp(line,"TEST")==0){
    if(state=='L'){Serial.println("TEST BUSY");return;}
    testing=true;testAt=millis();Serial.println("TEST OK");
  }
}
void setup(){
  pinMode(LED_RED,OUTPUT);pinMode(LED_GREEN,OUTPUT);pinMode(BUZZER,OUTPUT);
  digitalWrite(LED_RED,LED_OFF);digitalWrite(LED_GREEN,LED_OFF);digitalWrite(BUZZER,BUZZER_OFF);
  pinMode(ACK_BUTTON,INPUT_PULLUP);pinMode(BOOT_BUTTON,INPUT_PULLUP);raw=stable=buttonPressed();
  Serial.begin(115200);
  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);
}
void loop(){
  while(Serial.available()>0){
    char c=char(Serial.read());
    if(c=='\n'){
      if(!overflow){line[length]='\0';command();}
      length=0;overflow=false;
    }else if(c!='\r'&&!overflow){
      if(length<sizeof(line)-1)line[length++]=c;else overflow=true;
    }
  }
  const uint32_t now=millis();
  const bool pressed=buttonPressed();
  if(accessPoint&&now-apStarted>=AP_DURATION)stopAP(true);
  if(raw!=pressed){raw=pressed;changed=now;}
  if(raw!=stable&&now-changed>=35){
    stable=raw;
    if(stable&&state=='L'){state='A';pong();}
  }
  if(testing&&now-testAt>=1000)testing=false;
  const bool alarm=state=='L', red=alarm||(testing&&now-testAt<500);
  const bool beep=(alarm&&(now-started)%1200<160)||(testing&&now-testAt<200);
  digitalWrite(LED_RED,red?LED_ON:LED_OFF);
  digitalWrite(LED_GREEN,red?LED_OFF:LED_ON);
  digitalWrite(BUZZER,beep?BUZZER_ON:BUZZER_OFF);
}
