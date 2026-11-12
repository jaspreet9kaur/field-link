package org.fieldlink.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

public final class RoomService extends Service {
    private static final int STATUS_ID=470, CALL_ID=471;
    private static final String CHANNEL_STATUS="local-listener", CHANNEL_TEXT="local-message", CHANNEL_CALL="local-calls";
    private RoomStore store;
    private NotificationManager notifications;
    private ConnectivityManager networks;
    private ScheduledExecutorService executor;
    private PowerManager.WakeLock wake;
    private volatile boolean running=false;
    private String ringing="";
    private long ringingSince=0;
    private int currentState=0;
    @Override public void onCreate(){
        super.onCreate();
        store=new RoomStore(this);notifications=getSystemService(NotificationManager.class);
        networks=getSystemService(ConnectivityManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_STATUS,"Local connection",NotificationManager.IMPORTANCE_LOW));
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_TEXT,"Local messages",NotificationManager.IMPORTANCE_DEFAULT));
        NotificationChannel call=new NotificationChannel(CHANNEL_CALL,"Incoming calls",NotificationManager.IMPORTANCE_HIGH);
        call.enableVibration(true);
        call.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        notifications.createNotificationChannel(call);
        executor=Executors.newSingleThreadScheduledExecutor();
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(store.token().isEmpty()){stopSelf();return START_NOT_STICKY;}
        if(!running){
            if(Build.VERSION.SDK_INT>=29)startForeground(STATUS_ID,status("Looking for the ESP32 hub"),ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(STATUS_ID,status("Looking for the ESP32 hub"));
            running=true;
            wake=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FieldLink:LocalAlerts");
            wake.setReferenceCounted(false);wake.acquire(35*60_000L);
            executor.scheduleWithFixedDelay(this::poll,0,2200,TimeUnit.MILLISECONDS);
        }else if(wake!=null&&!wake.isHeld())wake.acquire(35*60_000L);
        if(intent!=null&&"decline".equals(intent.getAction())){
            final String id=intent.getStringExtra("call");
            if(id!=null&&id.matches("[a-f0-9-]{36}"))executor.execute(()->decline(id));
        }
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent i){return null;}
    @Override public void onDestroy(){
        running=false;
        executor.shutdownNow();notifications.cancel(CALL_ID);
        if(wake!=null&&wake.isHeld())wake.release();
        super.onDestroy();
    }
    private PendingIntent launch(int request,boolean ring,String answer){
        Intent i=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("proof",RoomStore.ACTION_PROOF);i.putExtra("ring",ring);if(answer!=null)i.putExtra("answer",answer);
        return PendingIntent.getActivity(this,request,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification status(String text){
        return new Notification.Builder(this,CHANNEL_STATUS).setSmallIcon(R.drawable.ic_fieldlink).setContentTitle("Field Link")
            .setContentText(text).setContentIntent(launch(1,false,null)).setOngoing(true).setOnlyAlertOnce(true).build();
    }
    private void statusIfChanged(boolean online){
        int next=online?1:2;if(currentState!=next){currentState=next;notifications.notify(STATUS_ID,status(online?"Listening on the local network":"Reconnecting to the local hub"));}
    }
    private JSONObject request(JSONObject payload,String token) throws Exception{
        final String origin=RoomStore.checked(store.address());
        if(origin.isEmpty()||!origin.equals(store.address()))throw new IllegalStateException("Invalid origin");
        final Network wifi=RoomStore.wifi(networks);
        if(wifi==null)throw new IllegalStateException("Wi-Fi is disconnected");
        HttpsURLConnection c=(HttpsURLConnection)wifi.openConnection(new URL(origin+"/api"));
        c.setInstanceFollowRedirects(false);c.setConnectTimeout(4500);c.setReadTimeout(4500);
        c.setRequestMethod("POST");c.setRequestProperty("Origin",origin);
        c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Authorization","Bearer "+token);
        c.setDoOutput(true);byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(bytes.length);
        try{
            try(java.io.OutputStream stream=c.getOutputStream()){stream.write(bytes);}
            int code=c.getResponseCode();
            if(code==401){store.clearSession();stopSelf();throw new IllegalStateException("Sign-in expired");}
            if(code!=200)throw new IllegalStateException("Hub request failed");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream()){
                byte[] buffer=new byte[512];int count;
                while((count=in.read(buffer))!=-1){if(output.size()+count>8192)throw new IllegalStateException("Hub response too large");output.write(buffer,0,count);}
                return new JSONObject(output.toString("UTF-8"));
            }
        }finally{c.disconnect();}
    }
    private void clearRing(){ringing="";ringingSince=0;notifications.cancel(CALL_ID);}
    private void decline(String id){
        try{
            String token=store.token();
            if(!token.isEmpty())request(new JSONObject().put("action","call").put("id",id).put("signal","decline"),token);
        }catch(Exception ignored){}
        if(ringing.equals(id))clearRing();
    }
    private void poll(){
        if(!running)return;
        if(!ringing.isEmpty()&&(MainActivity.visible||System.currentTimeMillis()-ringingSince>48_000L))clearRing();
        if(MainActivity.visible)return;
        try{
            String token=store.token();if(token.isEmpty()){stopSelf();return;}
            long[] old=store.cursor();
            JSONObject data=request(new JSONObject().put("action","watch").put("boot",old[0]).put("cursor",old[1]),token);
            long boot=data.getLong("boot"),cursor=old[1];
            if(boot!=old[0]){store.cursor(boot,0);clearRing();statusIfChanged(true);return;}
            JSONArray inbox=data.getJSONArray("events");
            for(int i=0;i<inbox.length();i++){
                JSONObject item=inbox.getJSONObject(i);cursor=Math.max(cursor,item.optLong("seq",0));
                String kind=item.optString("kind"),name=item.optString("name","Room member");
                if("offer".equals(kind)&&item.optBoolean("live",false)){
                    String id=item.optString("id");if(!id.matches("[a-f0-9-]{36}"))continue;
                    String mode=item.optString("mode");
                    if("voice".equals(mode)||"video".equals(mode))incoming(id,name,"video".equals(mode));
                }else if("end".equals(kind)&&ringing.equals(item.optString("id")))clearRing();
                else if("text".equals(kind)&&!item.optBoolean("mine",false))message(name,"New local message",cursor);
                else if("photo".equals(kind)&&!item.optBoolean("mine",false))message(name,"New photo",cursor);
            }
            store.cursor(boot,cursor);statusIfChanged(true);
        }catch(Exception ignored){statusIfChanged(false);}
    }
    private void message(String name,String detail,long seq){
        if(!notifications.areNotificationsEnabled())return;
        Notification n=new Notification.Builder(this,CHANNEL_TEXT).setSmallIcon(R.drawable.ic_fieldlink)
            .setContentTitle(name).setContentText(detail).setContentIntent(launch(2,false,null)).setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).build();
        notifications.notify(1000+(int)(seq%128),n);
    }
    private void incoming(String id,String name,boolean video){
        if(!notifications.areNotificationsEnabled())return;
        if(ringing.equals(id))return;
        ringing=id;ringingSince=System.currentTimeMillis();
        Intent d=new Intent(this,RoomService.class).setAction("decline").putExtra("call",id);
        PendingIntent decline=PendingIntent.getService(this,4,d,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answer=launch(5,true,id),screen=launch(6,true,null);
        Notification.Builder n=new Notification.Builder(this,CHANNEL_CALL).setSmallIcon(R.drawable.ic_fieldlink)
            .setContentTitle(name).setContentText(video?"Incoming video call":"Incoming voice call").setContentIntent(screen)
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE).setTimeoutAfter(47_000).setOngoing(true);
        if(Build.VERSION.SDK_INT>=31)n.setStyle(Notification.CallStyle.forIncomingCall(new Person.Builder().setName(name).setImportant(true).build(),decline,answer));
        else{n.addAction(new Notification.Action.Builder(null,"Decline",decline).build());n.addAction(new Notification.Action.Builder(null,"Answer",answer).build());}
        if(Build.VERSION.SDK_INT<34||notifications.canUseFullScreenIntent())n.setFullScreenIntent(screen,true);
        notifications.notify(CALL_ID,n.build());
    }
}
