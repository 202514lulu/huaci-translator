# 生成托盘图标 PNG（不依赖 PIL，手写 PNG 编码）
import zlib, struct, os

def make_png(path, size, pixels):
    """pixels: list of rows, each row list of (r,g,b,a)"""
    raw = b''
    for row in pixels:
        raw += b'\x00'  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        c += struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
        return c
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))

def rounded_square_icon(size=32, radius=7, bg=(47,111,237), fg=(255,255,255)):
    """画圆角方块，中间画一个简化的『译』字笔画（用矩形拼）"""
    px = [[(0,0,0,0) for _ in range(size)] for _ in range(size)]
    # 圆角矩形
    for y in range(size):
        for x in range(size):
            # 圆角判定
            inside = True
            corners = [(radius,radius), (size-1-radius,radius), (radius,size-1-radius), (size-1-radius,size-1-radius)]
            for cx, cy in corners:
                if (x < radius and y < radius and (cx,cy)==(radius,radius)) or \
                   (x > size-1-radius and y < radius and (cx,cy)==(size-1-radius,radius)) or \
                   (x < radius and y > size-1-radius and (cx,cy)==(radius,size-1-radius)) or \
                   (x > size-1-radius and y > size-1-radius and (cx,cy)==(size-1-radius,size-1-radius)):
                    if (x-cx)**2 + (y-cy)**2 > radius*radius:
                        inside = False
            if inside:
                px[y][x] = (*bg, 255)
    # 白色笔画：一个『讠』旁 + 右侧横竖，示意『译』
    def put(x0,y0,x1,y1,c=fg):
        for y in range(max(0,y0), min(size,y1+1)):
            for x in range(max(0,x0), min(size,x1+1)):
                if px[y][x][3] > 0:
                    px[y][x] = (*c, 255)
    # 左侧言字旁
    put(6, 8, 11, 9)      # 上横
    put(8, 8, 9, 16)      # 竖
    put(6, 16, 11, 17)    # 下横
    # 右侧：一点 + 两横一竖（简化『尺/又』结构）
    put(15, 8, 25, 9)     # 上横
    put(19, 11, 20, 21)   # 中竖
    put(15, 14, 25, 15)   # 中横
    put(15, 21, 25, 22)   # 下横
    return px

if __name__ == '__main__':
    base = os.path.dirname(os.path.abspath(__file__))
    assets = os.path.join(base, 'assets')
    os.makedirs(assets, exist_ok=True)
    for sz in (16, 24, 32, 48, 256):
        r = max(2, round(sz * 7 / 32))
        px = rounded_square_icon(sz, r)
        out = os.path.join(assets, f'tray-{sz}.png')
        make_png(out, sz, px)
        print('wrote', out, os.path.getsize(out), 'bytes')
