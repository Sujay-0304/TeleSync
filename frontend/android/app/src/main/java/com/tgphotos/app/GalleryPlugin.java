package com.tgphotos.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Size;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.Base64;

/**
 * Reads the device's whole camera roll (all folders) via MediaStore, and
 * streams a single file's bytes to JS for upload. This is the native half
 * that makes the Google-Photos-style gallery view possible on a phone.
 */
@CapacitorPlugin(
    name = "Gallery",
    permissions = {
        @Permission(alias = "photos", strings = {
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO
        }),
        @Permission(alias = "photosLegacy", strings = {
            Manifest.permission.READ_EXTERNAL_STORAGE
        })
    }
)
public class GalleryPlugin extends Plugin {

    private boolean hasPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return getPermissionState("photos") == com.getcapacitor.PermissionState.GRANTED
                || getContext().checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
        }
        return getContext().checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (hasPermission()) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        String alias = Build.VERSION.SDK_INT >= 33 ? "photos" : "photosLegacy";
        requestPermissionForAlias(alias, call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasPermission());
        call.resolve(r);
    }

    /** List all images + videos, newest first. Returns id, name, size, date, kind, uri. */
    @PluginMethod
    public void list(PluginCall call) {
        if (!hasPermission()) {
            call.reject("no-permission");
            return;
        }
        int limit = call.getInt("limit", 100000);
        JSArray items = new JSArray();
        try {
            // images
            queryInto(items, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image");
            // videos
            queryInto(items, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video");
        } catch (Exception e) {
            call.reject("query-failed: " + e.getMessage());
            return;
        }
        JSObject res = new JSObject();
        res.put("items", items);
        call.resolve(res);
    }

    private void queryInto(JSArray out, Uri base, String kind) {
        String[] proj = {
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE
        };
        String sort = MediaStore.MediaColumns.DATE_MODIFIED + " DESC";
        try (Cursor c = getContext().getContentResolver().query(base, proj, null, null, sort)) {
            if (c == null) return;
            int idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
            int nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
            int sizeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
            int dateCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED);
            int mimeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE);
            while (c.moveToNext()) {
                long id = c.getLong(idCol);
                Uri uri = ContentUris.withAppendedId(base, id);
                try {
                    JSObject o = new JSObject();
                    o.put("id", kind + "_" + id);
                    o.put("uri", uri.toString());
                    o.put("name", c.getString(nameCol));
                    o.put("size", c.getLong(sizeCol));
                    o.put("date", c.getLong(dateCol) * 1000L); // seconds -> ms
                    o.put("mime", c.getString(mimeCol));
                    o.put("kind", kind);
                    out.put(o);
                } catch (Exception ignore) {}
            }
        }
    }

    /**
     * Generate (and cache) a small JPEG thumbnail for one item and return its
     * file path. Tiny images = the webview grid stays smooth and all render.
     */
    @PluginMethod
    public void getThumbnail(PluginCall call) {
        String uriStr = call.getString("uri");
        String id = call.getString("id", "");
        if (uriStr == null) { call.reject("no-uri"); return; }
        try {
            File dir = new File(getContext().getCacheDir(), "thumbs");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, id.replaceAll("[^A-Za-z0-9_]", "_") + ".jpg");
            if (!out.exists() || out.length() == 0) {
                Bitmap bmp;
                if (Build.VERSION.SDK_INT >= 29) {
                    bmp = getContext().getContentResolver()
                        .loadThumbnail(Uri.parse(uriStr), new Size(320, 320), null);
                } else {
                    bmp = MediaStore.Images.Media.getBitmap(
                        getContext().getContentResolver(), Uri.parse(uriStr));
                }
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    bmp.compress(Bitmap.CompressFormat.JPEG, 80, fos);
                }
                bmp.recycle();
            }
            JSObject r = new JSObject();
            r.put("path", out.getAbsolutePath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("thumb-failed: " + e.getMessage());
        }
    }

    /** Stream-hash a file to SHA-256 hex — no whole-file-in-memory (avoids OOM). */
    @PluginMethod
    public void sha256(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("no-uri"); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            JSObject r = new JSObject();
            r.put("sha", sb.toString());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("sha-failed: " + e.getMessage());
        }
    }

    /** Stream-upload a file as multipart/form-data — no base64, no OOM. */
    @PluginMethod
    public void upload(PluginCall call) {
        String uriStr = call.getString("uri");
        String base = call.getString("base", "");
        String token = call.getString("token", "");
        String name = call.getString("name", "upload");
        if (uriStr == null || base.isEmpty()) { call.reject("bad-args"); return; }
        String boundary = "----tgp" + System.nanoTime();
        try {
            HttpURLConnection con = (HttpURLConnection) new URL(base + "/api/photos/upload").openConnection();
            con.setRequestMethod("POST");
            con.setRequestProperty("Authorization", "Bearer " + token);
            con.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            con.setDoOutput(true);
            con.setChunkedStreamingMode(1 << 16);
            con.setConnectTimeout(20000);
            con.setReadTimeout(120000);
            try (DataOutputStream os = new DataOutputStream(con.getOutputStream());
                 InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
                os.writeBytes("--" + boundary + "\r\n");
                os.writeBytes("Content-Disposition: form-data; name=\"files\"; filename=\"" + name + "\"\r\n");
                os.writeBytes("Content-Type: application/octet-stream\r\n\r\n");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                os.writeBytes("\r\n--" + boundary + "--\r\n");
            }
            int code = con.getResponseCode();
            con.disconnect();
            JSObject r = new JSObject();
            r.put("ok", code < 300);
            r.put("status", code);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("upload-failed: " + e.getMessage());
        }
    }

    /** Read one file's bytes as base64 (JS turns it into a Blob for upload). */
    @PluginMethod
    public void readFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("no-uri"); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[1 << 16];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            JSObject r = new JSObject();
            r.put("data", Base64.getEncoder().encodeToString(buf.toByteArray()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("read-failed: " + e.getMessage());
        }
    }
}
