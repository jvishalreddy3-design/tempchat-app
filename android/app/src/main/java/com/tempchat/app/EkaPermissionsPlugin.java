package com.tempchat.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "EkaPermissions",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class EkaPermissionsPlugin extends Plugin {

    private static final String PREFERENCES_NAME = "eka_permissions";
    private static final String NOTIFICATION_REQUESTED_KEY = "notification_permission_requested";

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        resolveNotificationStatus(call);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolveNotificationStatus(call);
            return;
        }

        if (hasNotificationPermission()) {
            resolveNotificationStatus(call);
            return;
        }

        getPreferences().edit().putBoolean(NOTIFICATION_REQUESTED_KEY, true).apply();
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (call == null) return;
        resolveNotificationStatus(call);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent notificationIntent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationIntent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            notificationIntent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            notificationIntent = appDetailsIntent();
        }
        notificationIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(notificationIntent);
        } catch (Exception firstError) {
            Intent fallbackIntent = appDetailsIntent();
            fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(fallbackIntent);
            } catch (Exception fallbackError) {
                call.reject("Unable to open Android settings.", fallbackError);
                return;
            }
        }

        JSObject result = new JSObject();
        result.put("opened", true);
        call.resolve(result);
    }

    private Intent appDetailsIntent() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        return intent;
    }

    private void resolveNotificationStatus(PluginCall call) {
        boolean runtimePermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
        boolean permissionGranted = !runtimePermission || hasNotificationPermission();
        boolean notificationsEnabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        boolean hasRequested = getPreferences().getBoolean(NOTIFICATION_REQUESTED_KEY, false);
        boolean canPrompt = runtimePermission && !permissionGranted && !hasRequested;

        String status;
        if (notificationsEnabled && permissionGranted) {
            status = "granted";
        } else if (!permissionGranted) {
            status = "denied";
        } else {
            status = "disabled";
        }

        JSObject result = new JSObject();
        result.put("status", status);
        result.put("supported", true);
        result.put("runtimePermission", runtimePermission);
        result.put("permissionGranted", permissionGranted);
        result.put("notificationsEnabled", notificationsEnabled);
        result.put("hasRequested", hasRequested);
        result.put("canPrompt", canPrompt);
        result.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    private boolean hasNotificationPermission() {
        return (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        );
    }

    private SharedPreferences getPreferences() {
        return getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }
}
