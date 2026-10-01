/* prepare.js — 把上层 Web 应用拷进 www/,并给生成的安卓工程注入摄像头权限 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');          // storm-cam 根目录(Web 应用)
const www = path.join(__dirname, 'www');

// 1) 同步 Web 资源
fs.rmSync(www, { recursive: true, force: true });
for (const d of ['css', 'js', 'icons']) fs.mkdirSync(path.join(www, d), { recursive: true });
for (const f of ['index.html', 'manifest.json', 'sw.js']) {
  fs.copyFileSync(path.join(root, f), path.join(www, f));
}
fs.copyFileSync(path.join(root, 'css', 'style.css'), path.join(www, 'css', 'style.css'));
for (const f of ['lut.js', 'gl.js', 'app.js']) {
  fs.copyFileSync(path.join(root, 'js', f), path.join(www, 'js', f));
}
for (const f of fs.readdirSync(path.join(root, 'icons'))) {
  fs.copyFileSync(path.join(root, 'icons', f), path.join(www, 'icons', f));
}
console.log('✓ www/ 已同步 Web 应用');

// 2) 若安卓工程已生成,注入相机/麦克风权限(幂等)
const manifestPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let xml = fs.readFileSync(manifestPath, 'utf8');
  const perms = [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS'
  ];
  let changed = false;
  for (const p of perms) {
    if (!xml.includes(`"${p}"`)) {
      xml = xml.replace(/(<manifest[^>]*>)/, `$1\n    <uses-permission android:name="${p}" />`);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(manifestPath, xml);
    console.log('✓ AndroidManifest 已注入 CAMERA / RECORD_AUDIO 权限');
  }
}
