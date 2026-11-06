package com.tgphotos.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

/**
 * Stores backup config (server URL + token) and schedules/cancels the
 * periodic WorkManager job that backs up new photos with the app closed.
 */
@CapacitorPlugin(name = "Backup")
public class BackupPlugin extends Plugin {

    static final String PREFS = "tgphotos_backup";
    static final String WORK = "tgphotos_periodic_backup";

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String base = call.getString("base", "");
        String token = call.getString("token", "");
        boolean enabled = call.getBoolean("enabled", false);
        boolean wifiOnly = call.getBoolean("wifiOnly", true);
        boolean chargingOnly = call.getBoolean("chargingOnly", false);

        prefs(getContext()).edit()
            .putString("base", base)
            .putString("token", token)
            .putBoolean("enabled", enabled)
            .putBoolean("wifiOnly", wifiOnly)
            .putBoolean("chargingOnly", chargingOnly)
            .apply();

        WorkManager wm = WorkManager.getInstance(getContext());
        if (enabled) {
            Constraints.Builder c = new Constraints.Builder()
                .setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED);
            if (chargingOnly) c.setRequiresCharging(true);
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                    BackupWorker.class, 1, TimeUnit.HOURS)  // ~hourly; Android min is 15m
                .setConstraints(c.build())
                .build();
            wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req);
        } else {
            wm.cancelUniqueWork(WORK);
        }
        JSObject r = new JSObject();
        r.put("ok", true);
        call.resolve(r);
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = prefs(getContext());
        JSObject r = new JSObject();
        r.put("enabled", p.getBoolean("enabled", false));
        r.put("wifiOnly", p.getBoolean("wifiOnly", true));
        r.put("chargingOnly", p.getBoolean("chargingOnly", false));
        r.put("lastRun", p.getLong("lastRun", 0));
        r.put("lastCount", p.getInt("lastCount", 0));
        call.resolve(r);
    }
}
