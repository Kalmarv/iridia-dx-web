; A pixel 1.1 program in Direct3D 8/9 assembly: texbem offsets the image's coordinate by a ripple map's two
; signed channels through the stage's bump matrix (pipeline state, not a constant), then tints it.
; Assembled by D3DAssemble (d3dcompiler_47).
ps_1_1
def c0, 0.85, 0.95, 1.0, 1.0
tex t0
texbem t1, t0
mul r0, t1, c0
