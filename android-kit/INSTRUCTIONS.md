# StormCam 安卓打包指南

两条路线,任选其一:

---

## 路线 A:GitHub 云端打包(本机无需装任何东西,推荐)

1. 把 `storm-cam` 整个文件夹推到 GitHub 仓库(根目录就是本文件夹,里面已带 `.github/workflows/android-apk.yml`)
2. 打开仓库 → **Actions** → **Build Android APK** → 等绿色对勾(约 5–8 分钟)
3. 在该次运行的 **Artifacts** 下载 `StormCam-debug-apk`
4. 传到手机安装(需允许「安装未知来源应用」)

## 路线 B:本机打包(需要 JDK 17–21 + Android Studio / Android SDK)

```bash
cd android-kit
npm install          # 安装 Capacitor(首次约 1 分钟)
npm run apk          # 自动:同步 www → cap add/sync → gradle 打包
# 产物:android/app/build/outputs/apk/debug/app-debug.apk
npm run open         # 可选:用 Android Studio 打开工程进一步调整
```

> 本机要求:`java -version` 显示 17–21(太新的 Java 26 与当前 Gradle/AGP 不兼容),
> 且装好 Android SDK(装 Android Studio 即自动带)。缺哪个,走路线 A 最省事。

---

## 安装后

- App 名为「StormCam 风暴相机」,打开后全屏运行
- 首次使用会弹出相机/麦克风权限,允许即可;若当时拒绝,去 系统设置 → 应用 → StormCam → 权限 手动打开
- WebView 通过 `https://localhost` 加载(安全上下文),`getUserMedia` 摄像头取流可用;
  斑马纹/假色/峰值/录制等全部功能与网页版一致
- 工程已自动注入 `CAMERA` / `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` 权限(见 `prepare.js`)

## 正式发布(release 签名)

debug 包仅供自用/测试。要上架或长期分发:

```bash
keytool -genkey -v -keystore stormcam.keystore -alias stormcam -keyalg RSA -keysize 2048 -validity 10000
cd android && gradlew assembleRelease   # 签名配置见 Android 官方文档「sign your app」
```

## 目录说明

| 文件 | 作用 |
| --- | --- |
| `capacitor.config.json` | 应用 ID `com.stormcam.app` / 名称 / WebView 配置 |
| `prepare.js` | 把上层 Web 应用(index/css/js/icons)同步到 `www/`,并注入相机权限 |
| `build.js` | 一键构建链:prepare → cap add/sync → gradle assembleDebug |
| `../.github/workflows/android-apk.yml` | 路线 A 的云端构建工作流 |
