# Sample project for [capacitor-mdns](https://github.com/devioarts/capacitor-mdns)

## Instalation from GitHub

### Download and extract the repo folder (Linux/Mac)
> To folder capacitor-mdns
```shell
curl -L https://codeload.github.com/devioarts/capacitor-examples/tar.gz/refs/heads/main \
| tar -xz --strip-components=1 capacitor-examples-main/capacitor-mdns
cd capacitor-mdns
```
> To current folder
```shell
curl -L https://codeload.github.com/devioarts/capacitor-examples/tar.gz/refs/heads/main \
| tar -xz --strip-components=2 capacitor-examples-main/capacitor-mdns
```

### Create a dist folder and install dependencies
```shell
# create dist folder
mkdir dist
# install dependencies
npm install
# first build
npm run dev:build
```
### Install iOS + Android
```shell
# add android
npx cap add android
# add ios
# if you want to use Podfile
npx cap add ios
# if you want to use SPM
npx cap add ios --packagemanager SPM
```

## Android
#### /android/app/src/main/AndroidManifest.xml
```xml
<uses-permission android:name="android.permission.INTERNET" />
```

```shell
npm run cap:open-android
```

## iOS
#### /ios/App/App/Info.plist
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

```shell
npm run cap:open-ios
```

## Electron

```shell
npm run electron:dev
```