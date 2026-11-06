package com.tgphotos.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(GalleryPlugin.class);
        registerPlugin(BackupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
