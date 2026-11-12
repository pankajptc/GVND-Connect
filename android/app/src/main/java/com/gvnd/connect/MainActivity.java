package com.gvnd.connect;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.telephony.SmsManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.math.BigInteger;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLServerSocketFactory;
import javax.security.auth.x500.X500Principal;

public class MainActivity extends BridgeActivity {
    private static volatile boolean serverStarted = false;
    private static final ConcurrentHashMap<String, ConcurrentHashMap<String, JSONObject>> rooms = new ConcurrentHashMap<>();
    private static final CopyOnWriteArrayList<JSONObject> signals = new CopyOnWriteArrayList<>();
    private static final ConcurrentHashMap<String, CopyOnWriteArrayList<JSONObject>> meshMail = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, byte[]> mediaBlobs = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> mediaTypes = new ConcurrentHashMap<>();
    private static final CopyOnWriteArrayList<String> discoveredNodes = new CopyOnWriteArrayList<>();
    private static int nextSignalId = 1;
    private static volatile String discoveredHostIp = "";
    private static volatile boolean smsSentDetected = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestAllRuntimePermissions();
        registerSmsSentObserver();
        startEmbeddedServers();

        try {
            WebView wv = getBridge().getWebView();
            wv.getSettings().setJavaScriptEnabled(true);
            wv.getSettings().setDomStorageEnabled(true);
            wv.getSettings().setMediaPlaybackRequiresUserGesture(false);
            wv.addJavascriptInterface(new WebAppInterface(), "AndroidBridge");
            wv.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> {
                        requestAllRuntimePermissions();
                        request.grant(request.getResources());
                    });
                }
            });
        } catch (Exception ignored) {}
    }

    public void requestAllRuntimePermissions() {
        List<String> needed = new ArrayList<>();
        String[] perms = new String[]{
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.WRITE_CONTACTS,
            };
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needed.add(p);
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, "android.permission.NEARBY_WIFI_DEVICES") != PackageManager.PERMISSION_GRANTED) {
            needed.add("android.permission.NEARBY_WIFI_DEVICES");
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), 1001);
        }
    }

    private void registerSmsSentObserver() {
        try {
            getContentResolver().registerContentObserver(Uri.parse("content://sms"), true, new ContentObserver(new Handler(Looper.getMainLooper())) {
                @Override
                public void onChange(boolean selfChange) {
                    super.onChange(selfChange);
                    smsSentDetected = true;
                    try {
                        WebView wv = getBridge().getWebView();
                        if (wv != null) {
                            wv.post(() -> wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('gvnd-sms-verified'));", null));
                        }
                    } catch (Exception ignored) {}
                }
            });
        } catch (Exception ignored) {}
    }

    public class WebAppInterface {
        @JavascriptInterface
        public String getHostUrl() {
            return "http://" + getLocalHotspotIp() + ":18081";
        }

        @JavascriptInterface
        public String getHttpsHostUrl() {
            return "https://" + getLocalHotspotIp() + ":18443";
        }

        @JavascriptInterface
        public String getLocalIp() {
            return getLocalHotspotIp();
        }

        @JavascriptInterface
        public String getDiscoveredNodes() {
            return new JSONArray(discoveredNodes).toString();
        }

        @JavascriptInterface
        public void requestPermissionsNow() {
            runOnUiThread(() -> requestAllRuntimePermissions());
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getPackageName(), null));
                startActivity(intent);
            });
        }

        @JavascriptInterface
        public String getContacts() {
            JSONArray list = new JSONArray();
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> requestAllRuntimePermissions());
                return "[]";
            }
            try {
                ContentResolver cr = getContentResolver();
                Cursor cur = cr.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                        null, null, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
                if (cur != null) {
                    Set<String> seen = new HashSet<>();
                    while (cur.moveToNext()) {
                        String name = cur.getString(0);
                        String num = cur.getString(1);
                        if (num != null) {
                            String clean = num.replaceAll("[^0-9+]", "");
                            if (!clean.isEmpty() && !seen.contains(clean)) {
                                seen.add(clean);
                                JSONObject o = new JSONObject();
                                o.put("name", name != null ? name : clean);
                                o.put("tel", clean);
                                list.put(o);
                            }
                        }
                    }
                    cur.close();
                }
            } catch (Exception ignored) {}
            return list.toString();
        }

        @JavascriptInterface
        public boolean sendSms(String phoneNumber, String message) {
            try {
                Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(phoneNumber)));
                intent.putExtra("sms_body", message);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                smsSentDetected = true;
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        WebView wv = getBridge().getWebView();
                        if (wv != null) {
                            wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('gvnd-sms-verified'));", null);
                        }
                    } catch (Exception ignored) {}
                }, 3500);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean isSmsVerified() {
            return smsSentDetected;
        }

        @JavascriptInterface
        public void saveAndOpenFile(String base64Data, String fileName, String mimeType) {
            try {
                String cleanB64 = base64Data.contains(",") ? base64Data.split(",", 2)[1] : base64Data;
                byte[] bytes = android.util.Base64.decode(cleanB64, android.util.Base64.DEFAULT);
                File dir = new File(getExternalFilesDir(null), "GVND_Downloads");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, fileName);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(bytes);
                }
            } catch (Exception ignored) {}
        }
    }

    public static String getLocalHotspotIp() {
        try {
            String fallback = "";
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements(); ) {
                NetworkInterface intf = en.nextElement();
                if (!intf.isUp() || intf.isLoopback()) continue;
                String name = intf.getName().toLowerCase();
                for (Enumeration<InetAddress> enumIpAddr = intf.getInetAddresses(); enumIpAddr.hasMoreElements(); ) {
                    InetAddress inetAddress = enumIpAddr.nextElement();
                    if (!inetAddress.isLoopbackAddress() && inetAddress instanceof Inet4Address) {
                        String ip = inetAddress.getHostAddress();
                        if (name.contains("ap") || name.contains("wlan") || name.contains("swlan")) return ip;
                        if (fallback.isEmpty()) fallback = ip;
                    }
                }
            }
            return fallback.isEmpty() ? "127.0.0.1" : fallback;
        } catch (Exception e) {
            return "127.0.0.1";
        }
    }

    private SSLContext createSelfSignedSslContext() {
        try {
            String alias = "gvnd_local_tls_v1";
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (!ks.containsAlias(alias)) {
                KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
                Calendar start = Calendar.getInstance();
                Calendar end = Calendar.getInstance();
                end.add(Calendar.YEAR, 5);
                KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                        .setKeySize(2048)
                        .setCertificateSubject(new X500Principal("CN=GVND Connect Local Node"))
                        .setCertificateSerialNumber(BigInteger.valueOf(System.currentTimeMillis()))
                        .setCertificateNotBefore(start.getTime())
                        .setCertificateNotAfter(end.getTime())
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                        .build();
                kpg.initialize(spec);
                kpg.generateKeyPair();
            }
            KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(ks, null);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(kmf.getKeyManagers(), null, null);
            return ctx;
        } catch (Exception e) {
            return null;
        }
    }

    private void startEmbeddedServers() {
        if (serverStarted) return;
        serverStarted = true;

        // 1. UDP Port 18082: LAN/Hotspot Auto-Discovery
        new Thread(() -> {
            try {
                DatagramSocket udp = new DatagramSocket(null);
                udp.setReuseAddress(true);
                udp.setBroadcast(true);
                udp.bind(new InetSocketAddress("0.0.0.0", 18082));

                new Thread(() -> {
                    byte[] buf = new byte[2048];
                    while (true) {
                        try {
                            DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                            udp.receive(pkt);
                            String msg = new String(pkt.getData(), 0, pkt.getLength(), StandardCharsets.UTF_8);
                            JSONObject j = new JSONObject(msg);
                            String senderIp = pkt.getAddress().getHostAddress();
                            if ("GVND_BEACON".equals(j.optString("type")) && !senderIp.equals(getLocalHotspotIp()) && !"127.0.0.1".equals(senderIp)) {
                                discoveredHostIp = senderIp;
                                String url = "http://" + senderIp + ":18081";
                                if (!discoveredNodes.contains(url)) discoveredNodes.add(url);
                            }
                        } catch (Exception ignored) {}
                    }
                }).start();

                while (true) {
                    try {
                        JSONObject beacon = new JSONObject();
                        beacon.put("type", "GVND_BEACON");
                        beacon.put("ip", getLocalHotspotIp());
                        beacon.put("httpPort", 18081);
                        beacon.put("httpsPort", 18443);
                        byte[] data = beacon.toString().getBytes(StandardCharsets.UTF_8);
                        udp.send(new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), 18082));
                        udp.send(new DatagramPacket(data, data.length, InetAddress.getByName("192.168.43.255"), 18082));
                    } catch (Exception ignored) {}
                    Thread.sleep(2000);
                }
            } catch (Exception ignored) {}
        }).start();

        // 2. HTTP Port 18081
        new Thread(() -> {
            try {
                ServerSocket server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress("0.0.0.0", 18081));
                while (true) {
                    Socket client = server.accept();
                    new Thread(() -> handleClient(client, false)).start();
                }
            } catch (Exception ignored) {}
        }).start();

        // 3. HTTPS Port 18443 (Compulsory Dual HTTPS for Browser WebRTC Camera/Mic)
        new Thread(() -> {
            try {
                SSLContext sslCtx = createSelfSignedSslContext();
                if (sslCtx != null) {
                    SSLServerSocketFactory ssf = sslCtx.getServerSocketFactory();
                    SSLServerSocket sslServer = (SSLServerSocket) ssf.createServerSocket();
                    sslServer.setReuseAddress(true);
                    sslServer.bind(new InetSocketAddress("0.0.0.0", 18443));
                    while (true) {
                        Socket client = sslServer.accept();
                        new Thread(() -> handleClient(client, true)).start();
                    }
                }
            } catch (Exception ignored) {}
        }).start();
    }

    private void handleClient(Socket client, boolean isHttps) {
        try {
            client.setSoTimeout(8000);
            InputStream in = client.getInputStream();
            ByteArrayOutputStream headerBuf = new ByteArrayOutputStream();
            int prev = -1, curr;
            int lineEndCount = 0;
            while ((curr = in.read()) != -1) {
                headerBuf.write(curr);
                if (prev == '\r' && curr == '\n') {
                    lineEndCount++;
                    if (lineEndCount == 2) break;
                } else if (curr != '\r') {
                    lineEndCount = 0;
                }
                prev = curr;
            }
            String headerText = headerBuf.toString("UTF-8");
            if (headerText.isEmpty()) { client.close(); return; }
            String[] lines = headerText.split("\r\n");
            String[] parts = lines[0].split(" ");
            String method = parts[0];
            String fullPath = parts.length > 1 ? parts[1] : "/";

            int contentLength = 0;
            String rangeHeader = null;
            String contentType = "application/octet-stream";
            for (int i = 1; i < lines.length; i++) {
                String l = lines[i];
                String lower = l.toLowerCase();
                if (lower.startsWith("content-length:")) contentLength = Integer.parseInt(l.substring(15).trim());
                else if (lower.startsWith("range:")) rangeHeader = l.substring(6).trim();
                else if (lower.startsWith("content-type:")) contentType = l.substring(13).trim();
            }

            byte[] bodyBytes = new byte[contentLength];
            int totalRead = 0;
            while (totalRead < contentLength) {
                int r = in.read(bodyBytes, totalRead, contentLength - totalRead);
                if (r == -1) break;
                totalRead += r;
            }
            String bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);

            if ("OPTIONS".equals(method)) {
                sendJson(client, "{\"ok\":true}");
                return;
            }

            URI uri = new URI("http://localhost" + fullPath);
            String path = uri.getPath();
            Map<String, String> q = parseQuery(uri.getRawQuery());

            if ("/api/info".equals(path) || "/api/health".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("localIp", getLocalHotspotIp());
                res.put("httpUrl", "http://" + getLocalHotspotIp() + ":18081");
                res.put("httpsUrl", "https://" + getLocalHotspotIp() + ":18443");
                res.put("discoveredHostIp", discoveredHostIp);
                res.put("smsVerified", smsSentDetected);
                sendJson(client, res.toString());
                return;
            }

            // Byte-Range Chunk Media Upload & Streaming (/api/stream/<id>)
            if (path.startsWith("/api/stream/")) {
                String id = path.substring("/api/stream/".length());
                if ("POST".equals(method)) {
                    mediaBlobs.put(id, bodyBytes);
                    mediaTypes.put(id, contentType);
                    sendJson(client, "{\"ok\":true,\"id\":\"" + id + "\"}");
                    return;
                } else {
                    byte[] data = mediaBlobs.get(id);
                    if (data == null) {
                        sendJson(client, "{\"error\":\"not_found\"}");
                        return;
                    }
                    String mime = mediaTypes.getOrDefault(id, "video/webm");
                    sendRangeBytes(client, data, mime, rangeHeader);
                    return;
                }
            }

            if ("/api/rtc".equals(path)) {
                if ("POST".equals(method)) {
                    JSONObject b = bodyStr.isEmpty() ? new JSONObject() : new JSONObject(bodyStr);
                    String op = b.optString("op");
                    String room = b.optString("room", "hub-mrt");
                    if ("leave".equals(op)) {
                        if (rooms.containsKey(room)) rooms.get(room).remove(b.optString("peer"));
                    } else if ("signal".equals(op)) {
                        synchronized (signals) {
                            b.put("id", nextSignalId++);
                            b.put("room", room);
                            signals.add(b);
                            if (signals.size() > 400) signals.remove(0);
                        }
                    }
                    sendJson(client, "{\"ok\":true}");
                    return;
                } else {
                    String room = q.getOrDefault("room", "hub-mrt");
                    String peer = q.getOrDefault("peer", "");
                    String name = q.getOrDefault("name", peer);
                    int since = 0;
                    try { since = Integer.parseInt(q.getOrDefault("since", "0")); } catch (Exception ignored) {}

                    rooms.putIfAbsent(room, new ConcurrentHashMap<>());
                    long now = System.currentTimeMillis();
                    if (!peer.isEmpty()) {
                        JSONObject pObj = new JSONObject();
                        pObj.put("id", peer);
                        pObj.put("name", name.isEmpty() ? peer : name);
                        pObj.put("ts", now);
                        rooms.get(room).put(peer, pObj);
                    }

                    JSONArray roster = new JSONArray();
                    Iterator it = rooms.get(room).entrySet().iterator();
                    while (it.hasNext()) {
                        Map.Entry e = (Map.Entry) it.next();
                        if (now - ((JSONObject) e.getValue()).optLong("ts") > 25000) it.remove();
                        else {
                            JSONObject item = new JSONObject();
                            item.put("id", ((JSONObject) e.getValue()).optString("id"));
                            item.put("name", ((JSONObject) e.getValue()).optString("name"));
                            roster.put(item);
                        }
                    }

                    JSONArray inbox = new JSONArray();
                    int cursor = since;
                    synchronized (signals) {
                        for (JSONObject s : signals) {
                            int sid = s.optInt("id");
                            if (room.equals(s.optString("room")) && sid > since && (peer.isEmpty() || peer.equals(s.optString("to")))) {
                                inbox.put(s);
                                if (sid > cursor) cursor = sid;
                            }
                        }
                    }
                    JSONObject res = new JSONObject();
                    res.put("peers", roster);
                    res.put("signals", inbox);
                    res.put("cursor", cursor);
                    res.put("lastId", cursor);
                    sendJson(client, res.toString());
                    return;
                }
            }

            if ("/api/mesh".equals(path)) {
                String uid = q.getOrDefault("uid", "global");
                if ("POST".equals(method)) {
                    JSONObject b = bodyStr.isEmpty() ? new JSONObject() : new JSONObject(bodyStr);
                    String target = b.optString("to", uid);
                    meshMail.putIfAbsent(target, new CopyOnWriteArrayList<>());
                    meshMail.get(target).add(b);
                    sendJson(client, "{\"ok\":true}");
                    return;
                } else {
                    JSONArray items = new JSONArray();
                    if (meshMail.containsKey(uid)) {
                        for (JSONObject m : meshMail.get(uid)) items.put(m);
                    }
                    JSONObject res = new JSONObject();
                    res.put("app", "GVND Connect");
                    res.put("items", items);
                    res.put("messages", items);
                    sendJson(client, res.toString());
                    return;
                }
            }

            // Serve embedded web assets from Android assets/public for browser users connecting via Hotspot IP
            String assetPath = path.equals("/") ? "public/index.html" : "public" + path;
            try (InputStream assetIn = getAssets().open(assetPath)) {
                byte[] assetBytes = readAllBytes(assetIn);
                String mime = guessMime(assetPath);
                sendRangeBytes(client, assetBytes, mime, rangeHeader);
            } catch (Exception e) {
                try (InputStream indexIn = getAssets().open("public/index.html")) {
                    byte[] indexBytes = readAllBytes(indexIn);
                    sendRangeBytes(client, indexBytes, "text/html; charset=utf-8", null);
                } catch (Exception ex) {
                    sendJson(client, "{\"ok\":true,\"app\":\"GVND Connect v1.0.1\"}");
                }
            }
        } catch (Exception ignored) {
        } finally {
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private void sendRangeBytes(Socket client, byte[] data, String mime, String rangeHeader) throws IOException {
        OutputStream out = client.getOutputStream();
        int total = data.length;
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            String[] rParts = rangeHeader.substring(6).split("-");
            int start = Integer.parseInt(rParts[0]);
            int end = (rParts.length > 1 && !rParts[1].isEmpty()) ? Math.min(Integer.parseInt(rParts[1]), total - 1) : Math.min(start + 524287, total - 1);
            int len = Math.max(0, end - start + 1);
            String headers = "HTTP/1.1 206 Partial Content\r\n" +
                    "Content-Type: " + mime + "\r\n" +
                    "Accept-Ranges: bytes\r\n" +
                    "Content-Range: bytes " + start + "-" + end + "/" + total + "\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Content-Length: " + len + "\r\n\r\n";
            out.write(headers.getBytes(StandardCharsets.UTF_8));
            out.write(data, start, len);
        } else {
            String headers = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: " + mime + "\r\n" +
                    "Accept-Ranges: bytes\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Content-Length: " + total + "\r\n\r\n";
            out.write(headers.getBytes(StandardCharsets.UTF_8));
            out.write(data);
        }
        out.flush();
    }

    private void sendJson(Socket client, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type,Range\r\n" +
                "Content-Length: " + bytes.length + "\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    private byte[] readAllBytes(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = in.read(buf)) != -1) baos.write(buf, 0, r);
        return baos.toByteArray();
    }

    private String guessMime(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".mp4")) return "video/mp4";
        if (path.endsWith(".webm")) return "video/webm";
        return "application/octet-stream";
    }

    private Map<String, String> parseQuery(String raw) {
        Map<String, String> map = new HashMap<>();
        if (raw == null || raw.isEmpty()) return map;
        for (String pair : raw.split("&")) {
            String[] kv = pair.split("=", 2);
            try {
                String k = URLDecoder.decode(kv[0], "UTF-8");
                String v = kv.length > 1 ? URLDecoder.decode(kv[1], "UTF-8") : "";
                map.put(k, v);
            } catch (Exception ignored) {}
        }
        return map;
    }
}
