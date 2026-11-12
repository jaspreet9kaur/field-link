package org.fieldlink.local;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.net.URI;
import java.net.URL;
import java.security.KeyStore;
import java.nio.charset.StandardCharsets;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class RoomStore {
    private static final String ALIAS="field-link-room-v1";
    static final String ACTION_PROOF=java.util.UUID.randomUUID().toString();
    private final SharedPreferences data;
    RoomStore(Context c){data=c.getSharedPreferences("local-room",Context.MODE_PRIVATE);}
    String address(){return data.getString("origin","");}
    void address(String origin){
        if(!origin.equals(address())) data.edit().clear().putString("origin",origin).apply();
    }
    synchronized void clearSession(){data.edit().remove("token").remove("boot").remove("cursor").apply();}
    private SecretKey key() throws Exception{
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);
        if(keys.containsAlias(ALIAS))return (SecretKey)keys.getKey(ALIAS,null);
        KeyGenerator generator=KeyGenerator.getInstance("AES","AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    synchronized void token(String token){
        if(!token.matches("[a-f0-9]{64}")){clearSession();return;}
        try{
            Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
            c.updateAAD(address().getBytes(StandardCharsets.UTF_8));
            String enc=Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(token.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
            data.edit().putString("token",enc).apply();
        }catch(Exception ignored){clearSession();}
    }
    synchronized String token(){
        String enc=data.getString("token","");if(enc.isEmpty())return "";
        try{
            String[] parts=enc.split(":",2);
            Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
            c.updateAAD(address().getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
        }catch(Exception ignored){clearSession();return "";}
    }
    synchronized long[] cursor(){return new long[]{data.getLong("boot",0),data.getLong("cursor",0)};}
    synchronized void cursor(long boot,long cursor){
        if(boot<1||cursor<0)return;
        long[] old=cursor();
        if(boot!=old[0]||cursor>old[1])data.edit().putLong("boot",boot).putLong("cursor",cursor).apply();
    }
    static String checked(String input){
        try{
            String value=input.trim();if(!value.startsWith("https://"))value="https://"+value;
            URI u=new URI(value);String host=u.getHost();
            if(host==null||!"https".equals(u.getScheme())||u.getUserInfo()!=null||u.getPort()!=-1||
                (u.getPath()!=null&&!u.getPath().isEmpty()&&!u.getPath().equals("/"))||u.getQuery()!=null||u.getFragment()!=null)return "";
            if(host.equalsIgnoreCase("fieldlink.local"))return "https://fieldlink.local";
            String[] parts=host.split("\\.",-1);if(parts.length!=4)return "";
            int[] n=new int[4];for(int i=0;i<4;i++){if(!parts[i].matches("0|[1-9][0-9]{0,2}"))return "";n[i]=Integer.parseInt(parts[i]);if(n[i]>255)return "";}
            return n[0]==10||(n[0]==192&&n[1]==168)||(n[0]==172&&n[1]>=16&&n[1]<=31)?"https://"+host:"";
        }catch(Exception ignored){return "";}
    }
    static boolean same(String address,String url){
        try{
            URL u=new URL(url);return u.getUserInfo()==null&&u.getPort()==-1&&("https://"+u.getHost()).equalsIgnoreCase(address)&&"https".equals(u.getProtocol());
        }catch(Exception ignored){return false;}
    }
    static Network wifi(ConnectivityManager m){
        for(Network n:m.getAllNetworks()){
            NetworkCapabilities c=m.getNetworkCapabilities(n);if(c!=null&&c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))return n;
        }return null;
    }
}
