"""Draws the Tea Cabinet mark: an ink enso around a tea bud and leaf.

    python3 scripts/make-icons.py public

writes the SVG sources into public/. The PNG home-screen icons in public/ are
those SVGs rendered at 180, 192 and 512 px (and 32 px for the favicon), so
re-render them whenever this file changes.
"""
import math, sys
def enso(cx, cy, R, wmax, start=-62, sweep=322, n=140, t0=0.0, t1=1.0, shift=0.0, thin=1.0):
    outer, inner = [], []
    for i in range(n+1):
        t = t0 + (t1-t0)*i/n
        a = math.radians(start - t*sweep)  # counter-clockwise on screen
        # brush pressure: quick press, gentle swell, long dry taper
        press = min(1, t/0.05)**0.5
        swell = 0.72 + 0.28*math.sin(math.pi*min(1, t/0.75))
        taper = 1 if t < 0.62 else ((1-t)/0.38)**0.9
        w = wmax * press * swell * taper * thin
        w = max(w, 0.6)
        r = R + 3.2*math.sin(a*3+0.7) + 2.0*math.sin(a*5) + t*6  # slight spiral outward
        # offset the stroke slightly inward toward the end, like a lifting brush
        r += shift
        ro, ri = r + w*0.55, r - w*0.45
        outer.append((cx + ro*math.cos(a), cy + ro*math.sin(a)))
        inner.append((cx + ri*math.cos(a), cy + ri*math.sin(a)))
    pts = outer + inner[::-1]
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"

def leaf(cx, cy, s):
    # a single tea leaf, tip to the upper right
    return (f"M{cx-0.62*s:.1f} {cy+0.55*s:.1f} "
            f"C{cx-0.70*s:.1f} {cy-0.05*s:.1f} {cx-0.05*s:.1f} {cy-0.62*s:.1f} {cx+0.66*s:.1f} {cy-0.66*s:.1f} "
            f"C{cx+0.62*s:.1f} {cy+0.02*s:.1f} {cx+0.05*s:.1f} {cy+0.62*s:.1f} {cx-0.62*s:.1f} {cy+0.55*s:.1f} Z")
def vein(cx, cy, s):
    return f"M{cx-0.58*s:.1f} {cy+0.50*s:.1f} Q{cx-0.02*s:.1f} {cy-0.02*s:.1f} {cx+0.56*s:.1f} {cy-0.56*s:.1f}"

PAPER, INK, MOSS = "#EEE7D8", "#2A2620", "#6F7D4E"
def svg(size=512, pad=1.0, bg=True, rounded=False, leaves=True):
    R = 150*pad; c = 256
    body = []
    if bg:
        body.append(f'<rect width="512" height="512" {"rx=\"112\"" if rounded else ""} fill="{PAPER}"/>')
        body.append(f'<rect width="512" height="512" {"rx=\"112\"" if rounded else ""} filter="url(#grain)" opacity="0.5"/>')
    body.append(f'<path d="{enso(c, c, R, 54*pad)}" fill="{INK}"/>')
    # the dry tail: the brush runs out of ink and leaves a few hair strands
    for sh, t0, t1, th in ((-15, 0.66, 0.93, 0.10), (13, 0.70, 0.97, 0.08), (22, 0.76, 0.90, 0.05)):
        body.append(f'<path d="{enso(c, c, R, 54*pad, t0=t0, t1=t1, shift=sh*pad, thin=th)}" fill="{INK}" opacity="0.85"/>')
    # one bud and a leaf from a shared stem, the classic tea pluck
    if not leaves:
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">{"".join(body)}</svg>\n'
    lx, ly, ls = c+8*pad, c+4*pad, 70*pad
    base = (lx-0.62*ls, ly+0.55*ls)
    bs = 44*pad
    bx, by = base[0]+0.62*bs, base[1]-0.55*bs
    body.append(f'<path d="{leaf(bx, by, bs)}" fill="{MOSS}" opacity="0.72" transform="rotate(-38 {base[0]:.1f} {base[1]:.1f})"/>')
    body.append(f'<path d="{leaf(lx, ly, ls)}" fill="{MOSS}"/>')
    body.append(f'<path d="{vein(lx, ly, ls)}" stroke="{PAPER}" stroke-width="{4*pad:.1f}" stroke-linecap="round" fill="none" opacity="0.5"/>')
    body.append(f'<path d="M{base[0]:.1f} {base[1]:.1f} q{-10*pad:.1f} {14*pad:.1f} {-24*pad:.1f} {20*pad:.1f}" stroke="{MOSS}" stroke-width="{5*pad:.1f}" stroke-linecap="round" fill="none"/>')
    defs = ('<defs><filter id="grain" x="0" y="0" width="100%" height="100%">'
            '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>'
            '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.28  0 0 0 0.35 0"/>'
            '<feComposite in2="SourceGraphic" operator="in"/></filter></defs>') if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">{defs}{"".join(body)}</svg>\n'

out = sys.argv[1]
open(f"{out}/icon.svg", "w").write(svg())                         # square full-bleed (iOS masks corners itself)
open(f"{out}/icon-maskable.svg", "w").write(svg(pad=0.78))         # inside Android's safe zone; render to PNG then delete
open(f"{out}/favicon.svg", "w").write(svg(rounded=True))
open(f"{out}/mark.svg", "w").write(svg(bg=False))                  # transparent, for the header
open(f"{out}/enso.svg", "w").write(svg(bg=False, leaves=False))    # bare brush circle, a watermark on cards
