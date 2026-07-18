import struct, zlib, os

def png(width, height, pixels):
    # pixels: list of rows, each row list of (r,g,b,a)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
        return c
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

def make_icon(size):
    bg1 = (79, 140, 255)   # accent blue
    bg2 = (58, 111, 216)
    white = (255, 255, 255)
    px = [[(15, 20, 32, 0) for _ in range(size)] for _ in range(size)]
    r = size * 0.18  # corner radius for rounded square
    cx = cy = size / 2.0

    def in_rounded(x, y):
        # rounded-rect mask across full icon with margin
        m = size * 0.06
        left, top, right, bot = m, m, size - m, size - m
        if x < left + r and y < top + r:
            return (x-(left+r))**2 + (y-(top+r))**2 <= r*r
        if x > right - r and y < top + r:
            return (x-(right-r))**2 + (y-(top+r))**2 <= r*r
        if x < left + r and y > bot - r:
            return (x-(left+r))**2 + (y-(bot-r))**2 <= r*r
        if x > right - r and y > bot - r:
            return (x-(right-r))**2 + (y-(bot-r))**2 <= r*r
        return left <= x <= right and top <= y <= bot

    # lock geometry
    body_w = size * 0.44
    body_h = size * 0.34
    body_x0 = cx - body_w/2
    body_y0 = cy - body_h*0.15
    body_x1 = cx + body_w/2
    body_y1 = body_y0 + body_h
    body_r = size * 0.05

    shackle_outer = size * 0.17
    shackle_inner = size * 0.10
    shackle_cy = body_y0

    def in_body(x, y):
        if body_x0+body_r <= x <= body_x1-body_r and body_y0 <= y <= body_y1:
            return True
        if body_x0 <= x <= body_x1 and body_y0+body_r <= y <= body_y1-body_r:
            return True
        for (rx, ry) in [(body_x0+body_r, body_y0+body_r),(body_x1-body_r, body_y0+body_r),
                         (body_x0+body_r, body_y1-body_r),(body_x1-body_r, body_y1-body_r)]:
            if (x-rx)**2 + (y-ry)**2 <= body_r*body_r:
                return True
        return False

    def in_shackle(x, y):
        d = ((x-cx)**2 + (y-shackle_cy)**2) ** 0.5
        if shackle_inner <= d <= shackle_outer and y <= shackle_cy:
            return True
        # vertical legs down to body
        if shackle_inner <= abs(x-cx) <= shackle_outer and shackle_cy <= y <= body_y0+size*0.02:
            return True
        return False

    def in_keyhole(x, y):
        # small circle + stem carved into body (drawn as bg color)
        kx, ky = cx, body_y0 + body_h*0.42
        cr = size * 0.045
        if (x-kx)**2 + (y-ky)**2 <= cr*cr:
            return True
        if abs(x-kx) <= cr*0.5 and ky <= y <= ky + body_h*0.30:
            return True
        return False

    for y in range(size):
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            if not in_rounded(fx, fy):
                continue
            # gradient background
            t = y / size
            r_ = int(bg1[0]*(1-t) + bg2[0]*t)
            g_ = int(bg1[1]*(1-t) + bg2[1]*t)
            b_ = int(bg1[2]*(1-t) + bg2[2]*t)
            color = (r_, g_, b_, 255)
            if in_shackle(fx, fy) or (in_body(fx, fy) and not in_keyhole(fx, fy)):
                color = (white[0], white[1], white[2], 255)
            px[y][x] = color
    return png(size, size, px)

os.makedirs("icons", exist_ok=True)
for s in (16, 48, 128):
    data = make_icon(s)
    with open(os.path.join("icons", f"icon{s}.png"), "wb") as f:
        f.write(data)
    print("wrote icons/icon%d.png (%d bytes)" % (s, len(data)))
