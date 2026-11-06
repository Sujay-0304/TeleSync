package com.tgphotos.app;

import android.content.ContentUris;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Periodic background backup: find gallery items newer than the last run,
 * ask the server which are missing (by sha256), upload those. Runs with the
 * app closed, under the WorkManager constraints (wifi/charging).
 */
public class BackupWorker extends Worker {

    public BackupWorker(@NonNull Context ctx, @NonNull WorkerParameters p) { super(ctx, p); }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = BackupPlugin.prefs(getApplicationContext());
        String base = prefs.getString("base", "");
        String token = prefs.getString("token", "");
        if (base.isEmpty() || token.isEmpty()) return Result.success();

        try {
            List<long[]> media = recentMedia();       // [id, kind(0=img,1=vid), size, dateMs]
            if (media.isEmpty()) { stamp(prefs, 0); return Result.success(); }

            // hash each candidate, ask server which are new
            List<Uri> uris = new ArrayList<>();
            List<String> names = new ArrayList<>();
            List<String> shas = new ArrayList<>();
            for (long[] m : media) {
                Uri uri = ContentUris.withAppendedId(
                    m[1] == 0 ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                              : MediaStore.Video.Media.EXTERNAL_CONTENT_URI, m[0]);
                String sha = sha256(uri);
                if (sha == null) continue;
                uris.add(uri); shas.add(sha); names.add("m_" + m[0]);
            }
            Set<String> have = checkHashes(base, token, shas);

            int uploaded = 0;
            for (int i = 0; i < uris.size(); i++) {
                if (have.contains(shas.get(i))) continue;
                if (upload(base, token, uris.get(i))) uploaded++;
            }
            stamp(prefs, uploaded);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private void stamp(SharedPreferences p, int count) {
        p.edit().putLong("lastRun", System.currentTimeMillis()).putInt("lastCount", count).apply();
    }

    private List<long[]> recentMedia() {
        List<long[]> out = new ArrayList<>();
        String[] proj = { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE,
                          MediaStore.MediaColumns.DATE_MODIFIED };
        String sort = MediaStore.MediaColumns.DATE_MODIFIED + " DESC LIMIT 300";
        Uri[] bases = { MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        MediaStore.Video.Media.EXTERNAL_CONTENT_URI };
        for (int k = 0; k < bases.length; k++) {
            try (Cursor c = getApplicationContext().getContentResolver()
                    .query(bases[k], proj, null, null, sort)) {
                if (c == null) continue;
                int id = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                int sz = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                int dt = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED);
                while (c.moveToNext()) out.add(new long[]{ c.getLong(id), k, c.getLong(sz), c.getLong(dt) });
            }
        }
        return out;
    }

    private String sha256(Uri uri) {
        try (InputStream in = getApplicationContext().getContentResolver().openInputStream(uri)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { return null; }
    }

    private Set<String> checkHashes(String base, String token, List<String> shas) throws Exception {
        Set<String> have = new HashSet<>();
        if (shas.isEmpty()) return have;
        HttpURLConnection con = (HttpURLConnection) new URL(base + "/api/photos/check").openConnection();
        con.setRequestMethod("POST");
        con.setRequestProperty("Authorization", "Bearer " + token);
        con.setRequestProperty("Content-Type", "application/json");
        con.setDoOutput(true);
        JSONObject body = new JSONObject();
        body.put("hashes", new JSONArray(shas));
        try (DataOutputStream os = new DataOutputStream(con.getOutputStream())) {
            os.write(body.toString().getBytes("UTF-8"));
        }
        if (con.getResponseCode() == 200) {
            String resp = readAll(con.getInputStream());
            JSONArray arr = new JSONObject(resp).getJSONArray("synced");
            for (int i = 0; i < arr.length(); i++) have.add(arr.getString(i));
        }
        con.disconnect();
        return have;
    }

    private boolean upload(String base, String token, Uri uri) {
        String boundary = "----tgp" + System.nanoTime();
        try {
            HttpURLConnection con = (HttpURLConnection) new URL(base + "/api/photos/upload").openConnection();
            con.setRequestMethod("POST");
            con.setRequestProperty("Authorization", "Bearer " + token);
            con.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            con.setDoOutput(true);
            con.setChunkedStreamingMode(1 << 16);
            String name = uri.getLastPathSegment() + ".jpg";
            try (DataOutputStream os = new DataOutputStream(con.getOutputStream());
                 InputStream in = getApplicationContext().getContentResolver().openInputStream(uri)) {
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
            return code < 300;
        } catch (Exception e) { return false; }
    }

    private String readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }
}
