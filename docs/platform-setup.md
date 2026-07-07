# Platform setup

## Android

Add the mDNS/network permissions to your Android manifest.

`android/app/src/main/AndroidManifest.xml`

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />

  <application>
    <!-- Your app configuration -->
  </application>
</manifest>
```

The plugin also declares these permissions in its own Android manifest, so they
are merged into your app during `npx cap sync`. Keeping them in your app
manifest is still useful when you want the native project to show the network
requirements explicitly.

On some devices, mDNS discovery can still return no results if multicast traffic is blocked by the
network, router, VPN, or device policy.

The plugin does not request location or `NEARBY_WIFI_DEVICES` by default. Add
those only if your app has separate Wi-Fi scanning or nearby-device features
that require them.

## iOS

Add the local network permissions and every Bonjour service type your app uses to
`ios/App/App/Info.plist`.

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>It is needed for the correct functioning of the application</string>
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
<key>NSBonjourServices</key>
<array>
    <string>_http._tcp</string>
</array>
```

For a custom service such as `_capmdnse2e._tcp.`, add `_capmdnse2e._tcp` to
`NSBonjourServices`.
