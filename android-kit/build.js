/* build.js — 一键出包:同步 www → cap add/sync → gradle assembleDebug(跨平台) */
const { spawnSync } = require('child_process');
const path = require('path');
const here = __dirname;
const isWin = process.platform === 'win32';

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, {
    stdio: 'inherit',
    cwd: opts.cwd || here,
    shell: true
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\n[!] 命令失败:${cmd}`);
    process.exit(r.status || 1);
  }
  return r.status === 0;
}

sh('node prepare.js');
// 首次生成 android 工程;已存在时该步失败属预期
sh('npx cap add android', { allowFail: true });
sh('node prepare.js');            // cap add 后再补一次权限注入
sh('npx cap sync android');
sh(isWin ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug', {
  cwd: path.join(here, 'android')
});

const apk = path.join(here, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (require('fs').existsSync(apk)) {
  console.log('\n✅ APK 已生成:', apk);
} else {
  console.error('\n[!] 未找到 APK 输出,请检查上方 gradle 日志');
  process.exit(1);
}
