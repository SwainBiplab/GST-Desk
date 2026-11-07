package in.gstdesk.app;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

/**
 * Background sync windows (prompt 43). WorkManager runs `SyncWorker` periodically (never more often
 * than every 15 minutes, only with a network, not on a low battery). The worker does not sync: it tells
 * the page, if the app's process is alive, that a window is open; the page's sync client then syncs
 * once. With the process gone nothing runs, so sync is confined to these windows and the foreground.
 */
@CapacitorPlugin(name = "BackgroundSync")
public class BackgroundSyncPlugin extends Plugin {
  private static final String WORK = "gst-sync-window";
  private static BackgroundSyncPlugin live;

  @Override
  public void load() {
    live = this;
  }

  @PluginMethod
  public void schedule(PluginCall call) {
    int every = Math.max(15, call.getInt("everyMinutes", 30));
    Constraints constraints = new Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .setRequiresBatteryNotLow(true)
      .build();
    PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, every, TimeUnit.MINUTES)
      .setConstraints(constraints)
      .build();
    WorkManager.getInstance(getContext())
      .enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
    call.resolve();
  }

  /**
   * Push needs Firebase, which is set up only when `google-services.json` is in the build. Asking the
   * push plugin to register without it brings the process down, so the page asks here first.
   */
  @PluginMethod
  public void pushAvailable(PluginCall call) {
    // by reflection: Firebase is the push plugin's dependency, not this module's
    boolean available;
    try {
      Class<?> firebase = Class.forName("com.google.firebase.FirebaseApp");
      Object apps = firebase.getMethod("getApps", android.content.Context.class).invoke(null, getContext());
      available = apps instanceof java.util.List && !((java.util.List<?>) apps).isEmpty();
    } catch (Throwable t) {
      available = false;
    }
    JSObject out = new JSObject();
    out.put("available", available);
    call.resolve(out);
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    WorkManager.getInstance(getContext()).cancelUniqueWork(WORK);
    call.resolve();
  }

  static void windowOpened() {
    BackgroundSyncPlugin p = live;
    if (p == null) return;
    p.notifyListeners("window", new JSObject(), true);
  }

  public static class SyncWorker extends Worker {
    public SyncWorker(Context context, WorkerParameters params) {
      super(context, params);
    }

    @Override
    public Result doWork() {
      windowOpened();
      return Result.success();
    }
  }
}
