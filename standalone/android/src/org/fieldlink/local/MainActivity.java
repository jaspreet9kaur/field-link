package org.fieldlink.local;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.media.AudioDeviceInfo;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import android.util.Base64;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    static volatile boolean visible=false;
    private static final int MEDIA=211, PHOTO=212, NOTIFY=213, SAVE=214, GEO=215;
    private RoomStore store;
    private WebView view;
    private LinearLayout nativeBar;
    private GeolocationPermissions.Callback geo;
    private String geoOrigin;
    private Ringtone ringtone;
    private Integer previousAudioMode;
    private PermissionRequest media;
    private ValueCallback<Uri[]> picker;
    private byte[] pendingSave;
    private String answerId="";
    private boolean pageReady=false;
    private volatile boolean captureFocus=false;
    private static final int MIC_RATE=16000, MIC_READ=960;
    private AudioRecord fallbackMic;
    private String fallbackCall="";
    private final short[] micSamples=new short[MIC_READ];
    private synchronized boolean openFallbackMic(String call){
        if(!visible||!captureFocus||checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)return false;
        if(fallbackMic!=null)return fallbackCall.equals(call);
        int min=AudioRecord.getMinBufferSize(MIC_RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
        if(min<=0)return false;
        try{
            fallbackMic=new AudioRecord(MediaRecorder.AudioSource.MIC,MIC_RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(min,3840));
            if(fallbackMic.getState()==AudioRecord.STATE_INITIALIZED){
                fallbackMic.startRecording();
                if(fallbackMic.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING){fallbackCall=call;return true;}
            }
        }catch(RuntimeException ignored){}
        closeFallbackMic(null);return false;
    }
    private synchronized String readFallbackMic(String call){
        if(!visible||fallbackMic==null||!fallbackCall.equals(call))return "";
        int count=fallbackMic.read(micSamples,0,MIC_READ,AudioRecord.READ_NON_BLOCKING);
        if(count<=0)return "";
        byte[] pcm=new byte[count*2];
        for(int i=0;i<count;i++){pcm[2*i]=(byte)micSamples[i];pcm[2*i+1]=(byte)(micSamples[i]>>8);}
        return Base64.encodeToString(pcm,Base64.NO_WRAP);
    }
    private synchronized void closeFallbackMic(String call){
        if(fallbackMic==null||(call!=null&&!fallbackCall.equals(call)))return;
        try{fallbackMic.stop();}catch(RuntimeException ignored){}
        fallbackMic.release();fallbackMic=null;fallbackCall="";
        java.util.Arrays.fill(micSamples,(short)0);
    }
    @Override public void onWindowFocusChanged(boolean focused){
        super.onWindowFocusChanged(focused);captureFocus=focused;
    }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);store=new RoomStore(this);capture(getIntent());
        if(store.address().isEmpty()){
            String configured=RoomStore.checked(getString(R.string.configured_hub));
            if(!configured.isEmpty())store.address(configured);
        }
        if(store.address().isEmpty())setup();else openRoom();
    }
    @Override protected void onNewIntent(Intent intent){
        super.onNewIntent(intent);setIntent(intent);capture(intent);sendAnswer();
    }
    private void capture(Intent i){
        if(i==null||!RoomStore.ACTION_PROOF.equals(i.getStringExtra("proof")))return;
        String id=i.getStringExtra("answer");
        if(id!=null&&id.matches("[a-f0-9-]{36}"))answerId=id;
        if(i.getBooleanExtra("ring",false)||!answerId.isEmpty()){
            if(Build.VERSION.SDK_INT>=27){setShowWhenLocked(true);setTurnScreenOn(true);}
        }
    }
    @Override protected void onStart(){
        super.onStart();visible=true;
        ConnectivityManager networks=getSystemService(ConnectivityManager.class);
        networks.bindProcessToNetwork(RoomStore.wifi(networks));
        if(store!=null&&!store.token().isEmpty())listen();
    }
    @Override protected void onStop(){visible=false;captureFocus=false;closeFallbackMic(null);ring(false);routeSpeaker(false);super.onStop();}
    @Override protected void onDestroy(){resolveGeo(false);ring(false);routeSpeaker(false);closeFallbackMic(null);if(media!=null)media.deny();if(view!=null)view.destroy();super.onDestroy();}
    private boolean hasLocation(){
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private void resolveGeo(boolean allow){
        if(geo==null)return;
        final GeolocationPermissions.Callback callback=geo;final String site=geoOrigin;
        geo=null;geoOrigin=null;callback.invoke(site,allow&&visible,false);
    }
    private void ring(boolean enabled){
        if(!enabled){if(ringtone!=null)ringtone.stop();ringtone=null;return;}
        if(!visible||ringtone!=null)return;
        ringtone=RingtoneManager.getRingtone(this,RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE));
        if(ringtone!=null){
            final Ringtone active=ringtone;
            if(Build.VERSION.SDK_INT>=28)active.setLooping(true);active.play();
            getWindow().getDecorView().postDelayed(()->{if(ringtone==active)ring(false);},48000);
        }
    }
    private synchronized boolean routeSpeaker(boolean enabled){
        AudioManager audio=getSystemService(AudioManager.class);
        if(audio==null)return false;
        try{
            if(!enabled){
                if(previousAudioMode==null)return true;
                if(Build.VERSION.SDK_INT>=31)audio.clearCommunicationDevice();else audio.setSpeakerphoneOn(false);
                audio.setMode(previousAudioMode);previousAudioMode=null;return true;
            }
            if(!visible)return false;
            if(previousAudioMode==null)previousAudioMode=audio.getMode();
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if(Build.VERSION.SDK_INT>=31){
                for(AudioDeviceInfo device:audio.getAvailableCommunicationDevices())
                    if(device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER&&audio.setCommunicationDevice(device))return true;
                routeSpeaker(false);return false;
            }
            audio.setSpeakerphoneOn(true);return audio.isSpeakerphoneOn();
        }catch(RuntimeException e){return false;}
    }
    private void listen(){
        try{startForegroundService(new Intent(this,RoomService.class));}catch(RuntimeException e){Toast.makeText(this,"Open Field Link again to enable local alerts.",Toast.LENGTH_SHORT).show();}
    }
    private void notificationSettings(){
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},NOTIFY);
        }else if(Build.VERSION.SDK_INT>=34&&!getSystemService(NotificationManager.class).canUseFullScreenIntent()){
            try{startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,Uri.parse("package:"+getPackageName())));}catch(Exception ignored){}
        }else Toast.makeText(this,"Notifications are allowed. Keep the phone on the router Wi-Fi.",Toast.LENGTH_LONG).show();
    }
    private void setup(){
        closeFallbackMic(null);
        if(view!=null){((ViewGroup)view.getParent()).removeView(view);view.destroy();view=null;}
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setPadding(28,42,28,20);
        TextView brand=new TextView(this);brand.setText("FIELD LINK");brand.setTextColor(Color.rgb(90,229,244));brand.setTextSize(16);
        TextView title=new TextView(this);title.setText("Connect to your room.");title.setTextSize(30);title.setPadding(0,20,0,10);
        TextView help=new TextView(this);help.setText("Join the router Wi‑Fi, then enter the ESP32’s HTTPS address. The phone must trust the demo CA.");
        EditText address=new EditText(this);address.setSingleLine();address.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://<hub-address>");address.setText(store.address());
        Button connect=new Button(this);connect.setText("Open local room");
        connect.setOnClickListener(v->{
            String chosen=RoomStore.checked(address.getText().toString());
            if(chosen.isEmpty()){address.setError("Use the ESP32’s private IPv4 address or fieldlink.local");return;}
            store.address(chosen);openRoom();
        });
        page.addView(brand);page.addView(title);page.addView(help);page.addView(address);page.addView(connect);
        setContentView(page);
    }
    private void openRoom(){
        closeFallbackMic(null);
        if(view!=null)view.destroy();
        final String origin=store.address();pageReady=false;
        ConnectivityManager networks=getSystemService(ConnectivityManager.class);
        networks.bindProcessToNetwork(RoomStore.wifi(networks));
        LinearLayout panel=new LinearLayout(this);panel.setOrientation(LinearLayout.VERTICAL);
        LinearLayout bar=nativeBar=new LinearLayout(this);bar.setGravity(android.view.Gravity.END);bar.setPadding(12,0,12,0);
        TextView options=new TextView(this);options.setText("Options  ···");options.setTextColor(Color.rgb(166,206,224));
        options.setGravity(android.view.Gravity.CENTER);options.setMinHeight(Math.round(44*getResources().getDisplayMetrics().density));
        options.setPadding(16,0,12,0);options.setFocusable(true);options.setOnClickListener(v->{
            PopupMenu menu=new PopupMenu(this,options);
            menu.getMenu().add("Reconnect").setOnMenuItemClickListener(i->{openRoom();return true;});
            menu.getMenu().add("Alert permissions").setOnMenuItemClickListener(i->{notificationSettings();return true;});
            menu.getMenu().add("App permissions").setOnMenuItemClickListener(i->{
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));return true;
            });
            menu.getMenu().add("Hub address").setOnMenuItemClickListener(i->{setup();return true;});
            menu.show();
        });
        bar.addView(options);panel.addView(bar);
        view=new WebView(this);
        view.setBackgroundColor(Color.rgb(9,28,44));
        panel.addView(view,new LinearLayout.LayoutParams(-1,0,1));setContentView(panel);
        view.getSettings().setJavaScriptEnabled(true);view.getSettings().setDomStorageEnabled(false);
        view.getSettings().setAllowFileAccess(false);view.getSettings().setAllowContentAccess(false);
        view.getSettings().setMediaPlaybackRequiresUserGesture(false);
        view.getSettings().setGeolocationEnabled(true);
        view.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.addJavascriptInterface(new NativeRoom(origin),"FieldLinkNative");
        view.setWebViewClient(new WebViewClient(){
            @Override public void onPageStarted(WebView w,String url,Bitmap icon){resolveGeo(false);ring(false);routeSpeaker(false);closeFallbackMic(null);pageReady=false;}
            @Override public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest r){return !RoomStore.same(origin,r.getUrl().toString());}
            @Override public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest r){
                String s=r.getUrl().toString();
                if(RoomStore.same(origin,s)||s.startsWith("blob:"+origin+"/"))return null;
                return new WebResourceResponse("text/plain","utf-8",403,"Blocked",java.util.Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onReceivedSslError(WebView w,SslErrorHandler h,SslError error){
                h.cancel();new AlertDialog.Builder(MainActivity.this).setTitle("ESP32 certificate not trusted")
                    .setMessage("Install the Field Link ESP32 demo CA, then use Reconnect. Do not bypass certificate warnings.").setPositiveButton("OK",null).show();
            }
            @Override public void onPageFinished(WebView w,String url){pageReady=RoomStore.same(origin,url);sendAnswer();}
        });
        view.setWebChromeClient(new WebChromeClient(){
            @Override public void onGeolocationPermissionsShowPrompt(String site,GeolocationPermissions.Callback callback){
                if(!visible||!RoomStore.same(origin,site)){callback.invoke(site,false,false);return;}
                if(hasLocation()){callback.invoke(site,true,false);return;}
                resolveGeo(false);geo=callback;geoOrigin=site;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION},GEO);
            }
            @Override public void onGeolocationPermissionsHidePrompt(){resolveGeo(false);}
            @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->allowMedia(origin,request));}
            @Override public void onPermissionRequestCanceled(PermissionRequest request){runOnUiThread(()->{if(media==request)media=null;});}
            @Override public boolean onShowFileChooser(WebView w,ValueCallback<Uri[]> callback,FileChooserParams p){
                if(picker!=null)picker.onReceiveValue(null);picker=callback;
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
                try{startActivityForResult(i,PHOTO);return true;}catch(Exception ignored){picker=null;return false;}
            }
        });
        view.loadUrl(origin+"/");
    }
    private void sendAnswer(){
        if(pageReady&&view!=null&&!answerId.isEmpty()){
            view.evaluateJavascript("window.fieldLinkAnswerFromNotification?.("+JSONObject.quote(answerId)+")",null);answerId="";
        }
    }
    private void allowMedia(String origin,PermissionRequest request){
        if(!RoomStore.same(origin,request.getOrigin().toString())){request.deny();return;}
        ArrayList<String> need=new ArrayList<>();
        for(String item:request.getResources()){
            String permission=PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(item)?Manifest.permission.RECORD_AUDIO:
                PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(item)?Manifest.permission.CAMERA:null;
            if(permission==null){request.deny();return;}
            if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED&&!need.contains(permission))need.add(permission);
        }
        if(need.isEmpty()){request.grant(request.getResources());return;}
        if(media!=null)media.deny();media=request;requestPermissions(need.toArray(new String[0]),MEDIA);
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){
        super.onRequestPermissionsResult(code,permissions,results);
        if(code==GEO)resolveGeo(hasLocation());
        if(code==MEDIA&&media!=null){
            boolean ok=results.length>0;
            for(int result:results)if(result!=PackageManager.PERMISSION_GRANTED)ok=false;
            if(ok)media.grant(media.getResources());else media.deny();media=null;
        }
    }
    @Override protected void onActivityResult(int code,int result,Intent data){
        super.onActivityResult(code,result,data);
        if(code==PHOTO&&picker!=null){
            Uri uri=result==RESULT_OK&&data!=null?data.getData():null;
            picker.onReceiveValue(uri!=null&&"content".equals(uri.getScheme())?new Uri[]{uri}:null);picker=null;
        }
        if(code==SAVE){
            final byte[] bytes=pendingSave;pendingSave=null;
            final Uri dest=result==RESULT_OK&&data!=null?data.getData():null;
            if(bytes==null||dest==null||!"content".equals(dest.getScheme()))return;
            new Thread(()->{
                String status;
                try(java.io.OutputStream output=getContentResolver().openOutputStream(dest,"w")){
                    if(output==null)throw new java.io.IOException("No destination");
                    output.write(bytes);status="Photo saved.";
                }catch(Exception e){status="Could not save this photo.";}
                final String message=status;runOnUiThread(()->Toast.makeText(this,message,Toast.LENGTH_SHORT).show());
            },"FieldLink-photo-save").start();
        }
    }
    private final class NativeRoom {
        private final String origin;
        NativeRoom(String origin){this.origin=origin;}
        @JavascriptInterface public void useWebSettings(){if(origin.equals(store.address()))runOnUiThread(()->{if(nativeBar!=null)nativeBar.setVisibility(android.view.View.GONE);});}
        @JavascriptInterface public void openSettings(String target){
            if(!origin.equals(store.address()))return;
            runOnUiThread(()->{
                if(!visible)return;
                if("alerts".equals(target))notificationSettings();
                if("permissions".equals(target))startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));
                if("hub".equals(target))setup();
            });
        }
        @JavascriptInterface public void ringCall(boolean enabled){if(origin.equals(store.address()))runOnUiThread(()->ring(enabled));}
        @JavascriptInterface public boolean speaker(boolean enabled){return origin.equals(store.address())&&routeSpeaker(enabled);}
        @JavascriptInterface public String microphoneState(){
            if(!origin.equals(store.address())||!visible||!captureFocus)return "inactive";
            if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)return "permission";
            AudioManager audio=getSystemService(AudioManager.class);
            return audio!=null&&audio.isMicrophoneMute()?"muted":"allowed";
        }
        @JavascriptInterface public boolean openMicrophone(String call){
            return call!=null&&call.matches("[a-f0-9-]{36}")&&"allowed".equals(microphoneState())&&openFallbackMic(call);
        }
        @JavascriptInterface public String readMicrophone(String call){return origin.equals(store.address())?readFallbackMic(call):"";}
        @JavascriptInterface public void closeMicrophone(String call){if(call!=null&&origin.equals(store.address()))closeFallbackMic(call);}
        @JavascriptInterface public String restoreSession(){return origin.equals(store.address())?store.token():"";}
        @JavascriptInterface public void saveSession(String token,long boot,long cursor){
            if(!origin.equals(store.address()))return;
            store.token(token);store.cursor(boot,cursor);
            runOnUiThread(()->{if(token.isEmpty())stopService(new Intent(MainActivity.this,RoomService.class));else{
                listen();
                if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},NOTIFY);
            }});
        }
        @JavascriptInterface public void updateCursor(long boot,long cursor){if(origin.equals(store.address()))store.cursor(boot,cursor);}
        @JavascriptInterface public void savePhoto(String filename,String encoded){
            if(!origin.equals(store.address())||filename==null||!filename.matches("Field-Link-[a-f0-9]{8}\\.jpg")||encoded==null||encoded.length()>137000)return;
            final byte[] bytes;
            try{bytes=Base64.decode(encoded,Base64.NO_WRAP);}catch(IllegalArgumentException e){return;}
            if(bytes.length<24||bytes.length>102400||(bytes[0]&255)!=255||(bytes[1]&255)!=216||
                (bytes[bytes.length-2]&255)!=255||(bytes[bytes.length-1]&255)!=217)return;
            runOnUiThread(()->{
                if(!visible||pendingSave!=null)return;
                pendingSave=bytes;
                Intent pick=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("image/jpeg")
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,filename);
                try{startActivityForResult(pick,SAVE);}catch(Exception e){
                    pendingSave=null;Toast.makeText(MainActivity.this,"No save location is available.",Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}
