export type Color      = [number, number, number]
export type ColorAlpha = [number, number, number, number]

// one corner's radii — h curves along the horizontal edge, v along the vertical.
// CSS "border-radius: 20px / 40px" is h=20 v=40; the circular case is h === v.
export interface Corner {
  h: number
  v: number
}

export interface BorderRadius {
  // circular shorthand: every corner h = v = all (the overwhelmingly common case)
  all?:          number
  topLeft?:      Corner
  topRight?:     Corner
  bottomRight?:  Corner
  bottomLeft?:   Corner
}

export interface BoxShadow {
  x:       number
  y:       number
  blur:    number
  spread?: number | undefined
  color:   ColorAlpha
  inset?:  boolean
}

export interface GradientStop {
  color:    ColorAlpha
  position: number
  // px-positioned stops can't resolve to a fraction until the painted box (and thus
  // the gradient-line length) is known — carried raw, resolved at emit time
  posPx?:   number
}

export type Gradient =
  | { type: 'linear'; angle: number; corner?: string | undefined; repeating?: boolean | undefined; stops: GradientStop[] }
  // fx/fy: SVG-only focal point (a true, 0-radius inner circle per SVG's two-circle
  // radial model) — absent for CSS radial-gradient, which has no focal-point concept
  // and always uses cx/cy for both circles; when absent here too, downstream falls
  // back to cx/cy, reproducing that same same-center behavior unchanged
  | { type: 'radial'; cx?: number; cy?: number; fx?: number; fy?: number; radius?: number; repeating?: boolean | undefined; stops: GradientStop[] }

// conic gradients can't be expressed as PDF axial/radial shadings — they are
// rasterized through a canvas instead, so they live outside the Gradient union
export interface ConicGradient {
  fromDeg:    number
  cx:         number
  cy:         number
  repeating?: boolean | undefined
  stops:      GradientStop[]
}
