package in.gstdesk.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

/**
 * ESC/POS bytes to a paired printer over Bluetooth Classic (the serial port profile), prompt 43. The
 * page sends the bytes already laid out (`@gst/print`); this side only lists paired devices and writes.
 * Android 12+ asks for BLUETOOTH_CONNECT at run time; older versions had it at install.
 */
@CapacitorPlugin(
  name = "BtPrinter",
  permissions = {
    @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
  }
)
public class BtPrinterPlugin extends Plugin {
  private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

  private boolean needsPermission() {
    return Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED;
  }

  @PluginMethod
  public void list(PluginCall call) {
    if (needsPermission()) {
      requestPermissionForAlias("bluetooth", call, "afterPermission");
      return;
    }
    doList(call);
  }

  @PermissionCallback
  private void afterPermission(PluginCall call) {
    if (needsPermission()) {
      call.reject("Bluetooth permission was refused");
      return;
    }
    if ("print".equals(call.getMethodName())) doPrint(call);
    else doList(call);
  }

  private void doList(PluginCall call) {
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    JSArray devices = new JSArray();
    if (adapter != null) {
      try {
        Set<BluetoothDevice> paired = adapter.getBondedDevices();
        for (BluetoothDevice d : paired) {
          JSObject o = new JSObject();
          o.put("name", d.getName() == null ? d.getAddress() : d.getName());
          o.put("address", d.getAddress());
          devices.put(o);
        }
      } catch (SecurityException e) {
        call.reject("Bluetooth permission was refused");
        return;
      }
    }
    JSObject out = new JSObject();
    out.put("devices", devices);
    call.resolve(out);
  }

  @PluginMethod
  public void print(PluginCall call) {
    if (needsPermission()) {
      requestPermissionForAlias("bluetooth", call, "afterPermission");
      return;
    }
    doPrint(call);
  }

  private void doPrint(PluginCall call) {
    String address = call.getString("address");
    String data = call.getString("data");
    if (address == null || data == null) {
      call.reject("address and data are needed");
      return;
    }
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    if (adapter == null || !adapter.isEnabled()) {
      call.reject("Bluetooth is off");
      return;
    }
    byte[] bytes = Base64.decode(data, Base64.DEFAULT);
    // a socket per receipt: printers drop idle connections, and a fresh one is a few hundred milliseconds
    new Thread(() -> {
      BluetoothSocket socket = null;
      try {
        BluetoothDevice device = adapter.getRemoteDevice(address);
        socket = device.createRfcommSocketToServiceRecord(SPP);
        adapter.cancelDiscovery();
        socket.connect();
        OutputStream out = socket.getOutputStream();
        int chunk = 512;
        for (int i = 0; i < bytes.length; i += chunk) {
          out.write(bytes, i, Math.min(chunk, bytes.length - i));
          out.flush();
        }
        Thread.sleep(300);
        JSObject result = new JSObject();
        result.put("bytes", bytes.length);
        call.resolve(result);
      } catch (Exception e) {
        call.reject("The printer did not take the receipt: " + e.getMessage());
      } finally {
        try {
          if (socket != null) socket.close();
        } catch (Exception ignored) {}
      }
    }).start();
  }
}
