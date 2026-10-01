# -*- coding: utf-8 -*-
"""StormCam 图标生成器(纯标准库,无依赖):暗色镜头 + 风暴橙对焦环
用法: python tools/gen_icons.py  → 输出 icons/icon-192.png / icon-512.png / maskable-512.png
"""
import zlib, struct, math, os

def make_png(size, path, scale=1.0):
    """暗色渐变底 + 橙色风暴环 + 高光弧 + 白色快门芯"""
    cx = cy = (size - 1) / 2.0
    r_out = 0.36 * size * scale      # 环外径
    r_in = 0.295 * size * scale      # 环内径
    r_dot = 0.085 * size * scale     # 白色快门芯
    hl_a0, hl_a1 = math.radians(120), math.radians(215)  # 高光弧角度
    px = bytearray()
    for y in range(size):
        px.append(0)  # PNG 行滤波器:None
        for x in range(size):
            dx, dy = x - cx, y - cy
            rad = math.hypot(dx, dy)
            ang = math.atan2(-dy, dx)  # 数学角度,y 向上
            # 背景:左上亮右下暗的深蓝黑渐变
            t = (x + y) / (2.0 * size)
            br = 0.10 + 0.05 * (1.0 - t)
            cr, cg, cb = int(14 + 34 * br), int(18 + 44 * br), int(28 + 70 * br)
            if rad <= r_out:
                if rad > r_in:
                    # 风暴环:角度渐变 橙红→橙黄
                    k = (ang / (2 * math.pi) + 1.0) % 1.0
                    cr, cg, cb = int(255 - 15 * k), int(90 + 55 * k), int(60 - 20 * k)
                    edge = min(rad - r_in, r_out - rad)
                    if edge < 1.2:
                        a = max(0.0, min(1.0, edge / 1.2))
                        cr = int(cr * a + 14 * (1 - a)); cg = int(cg * a + 18 * (1 - a)); cb = int(cb * a + 28 * (1 - a))
                else:
                    # 内玻璃:深色微渐变
                    d = 1.0 - rad / r_in
                    cr, cg, cb = int(15 + 10 * d), int(20 + 14 * d), int(32 + 20 * d)
                    # 左上高光弧
                    if r_dot + 2 < rad <= r_in * 0.82 and hl_a0 <= ang <= hl_a1:
                        w = max(0.0, math.cos((ang - (hl_a0 + hl_a1) / 2) / ((hl_a1 - hl_a0) / 2)))
                        cr = int(cr + (235 - cr) * w); cg = int(cg + (240 - cg) * w); cb = int(cb + (248 - cb) * w)
                    if rad <= r_dot:
                        cr = cg = cb = 245
            elif rad < r_out + 1.2:
                # 环外缘抗锯齿
                a = max(0.0, min(1.0, (rad - r_out) / 1.2))
                cr = int(255 * (1 - a) + 14 * a); cg = int(90 * (1 - a) + 18 * a); cb = int(60 * (1 - a) + 28 * a)
            px += bytes((max(0, min(255, cr)), max(0, min(255, cg)), max(0, min(255, cb))))
    raw = bytes(px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print('ok', path, len(png), 'bytes')

base = os.path.join(os.path.dirname(__file__), '..', 'icons')
make_png(512, os.path.join(base, 'icon-512.png'))
make_png(192, os.path.join(base, 'icon-192.png'))
make_png(512, os.path.join(base, 'maskable-512.png'), scale=0.78)  # 内容缩进安全区
