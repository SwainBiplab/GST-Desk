package in.gstdesk.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // the app's own plugins (the community ones register themselves through cap sync)
    registerPlugin(BtPrinterPlugin.class);
    registerPlugin(BackgroundSyncPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
