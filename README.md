# 🌪️ StormCam 风暴相机

**线上地址:https://hayden-h-cmyht.github.io/stormcam/** (手机/电脑浏览器直接打开,可「安装为应用」离线使用)

一个致敬「飓风相机」的**实时电影感拍摄**网页应用:WebGL2 实时调色管线,「Log + 影调(LUT)直出」,配专业机内监视工具。纯前端,零依赖,无需安装。

![tech](https://img.shields.io/badge/tech-HTML5%20%2B%20WebGL2-blue) ![deps](https://img.shields.io/badge/dependencies-0-success)

## 快速开始

双击 `start.bat`(需要 Python 3),或手动:

```bash
cd storm-cam
python -m http.server 8787
# 浏览器打开 http://127.0.0.1:8787
```

> 摄像头权限要求 HTTPS 或 localhost,所以必须通过本地服务打开,不能直接双击 index.html。
> 没有摄像头也可以点「演示模式」体验完整调色管线。

## 功能对照(飓风相机 → StormCam)

| 飓风相机 | StormCam 实现 |
| --- | --- |
| Log + 实时影调直出 | 模拟 Log 曲线 + 10 款内置 3D LUT(青橙/胶片/夜幕/落日/黑白…),所见即所得,照片视频直接带调色 |
| 专业机内控制 | 曝光补偿 EV / 色温 / 色调 / ISO 感光度(带噪声模拟)/ 快门角度(动态模糊)/ 数码变焦 |
| 专业监视工具 | 斑马纹(过曝警告)、假色(曝光分布)、峰值对焦、RGB 直方图、构图网格 |
| 电影画幅 | 原生 / 16:9 / 2.35:1 宽银幕 / 1:1 |
| 拍摄 | JPEG 照片 + WebM 视频(含麦克风声音),时间码 HUD、音频电平表 |
| 相册 | 拍摄内容存 IndexedDB,刷新不丢;查看 / 下载 / 删除 |

监视工具(斑马/假色/峰值/网格/直方图)只用于监看,**不会**写入成片——与真实电影机一致。

## 技术结构

```
storm-cam/
├── index.html          界面骨架(PWA 入口)
├── css/style.css       电影机风格暗色 UI(含移动端适配)
├── js/lut.js           影调预设定义 + 32³ 3D LUT 烘焙(可独立测试)
├── js/gl.js            WebGL2 渲染引擎:Log→白平衡→LUT→曝光→颗粒,
│                       前帧反馈实现快门角度动态模糊;无 WebGL2 自动降级 2D
├── js/app.js           相机 / 录制 / 相册 / 仪表 / 双指变焦 / 亮屏锁
├── manifest.json       PWA 清单(安卓「安装为应用」)
├── sw.js               Service Worker 离线缓存
├── icons/              应用图标(tools/gen_icons.py 生成)
├── android-kit/        Capacitor 安卓打包套件(见其 INSTRUCTIONS.md)
└── .github/workflows/  GitHub 云端自动打包 APK
```

## 安卓版

两种方式,详见 [android-kit/INSTRUCTIONS.md](android-kit/INSTRUCTIONS.md):

1. **安装为应用(最快)**:把本目录推到 GitHub Pages(HTTPS)后,安卓 Chrome 打开 → 菜单「添加到主屏幕 / 安装应用」→ 获得全屏独立应用,支持离线,相机可用
2. **真 APK**:推到 GitHub 后 Actions 自动构建 `StormCam-debug-apk`(本机无需任何安卓环境);或本机装 JDK 17–21 + Android Studio 后在 `android-kit/` 执行 `npm install && npm run apk`

手机端已适配:竖屏时画幅自动转为 9:16/竖宽银幕、双指变焦、拍摄常亮(Wake Lock)、安全区留白。

管线全部在 GPU 着色器中完成,1080p 实时 30fps+;录制直接取调色后画布的 `captureStream`,保证「影调直出」。

## 已知限制

- 浏览器拿不到传感器原生 Log(那是 iPhone ProRes Log 的硬件能力),这里用曲线模拟,影调效果接近但动态范围不同。
- 视频为 WebM 格式(MediaRecorder 限制),时长元数据可能显示未知,播放正常;如需 MP4 可用 ffmpeg 转封装。
- 快门角度通过帧混合模拟(网络摄像头无法真实控制曝光时间)。
- Safari/Firefox 未系统测试,推荐 Chrome / Edge。

## 发布到 GitHub Pages

仓库推送后开启 Pages 即可——Pages 是 HTTPS,摄像头权限可直接使用,手机浏览器也能打开拍摄。
