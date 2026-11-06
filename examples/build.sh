#!/bin/sh
# Compiles the page's examples with Microsoft's compilers and stores each program's listing as Microsoft writes it
# (fxc /Fc, dxc -dumpbin), which the glue's tests compare dx's listings against. The compiled files are committed:
# the page's build does not need the compilers.
#
#   FXC="winrun /path/fxc.exe" DXC=/path/dxc-linux/bin/dxc web/examples/build.sh
#
# fxc runs under Wine on Linux (the user-local Wine of primase-oracles tools/wine); dxc 1.9.2609 runs natively.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
FXC=${FXC:-"$HOME/opt/wine/bin/winrun $HOME/opt/shader-tools/fxc-10.0.26100.4654/fxc.exe"}
DXC=${DXC:-"$HOME/opt/shader-tools/dxc-linux-1.9.2609/bin/dxc"}
D3DCOMPILER=${D3DCOMPILER:-"$HOME/opt/shader-tools/fxc-10.0.26100.4654/d3dcompiler_47.dll"}
WINPY=${WINPY:-"$HOME/opt/wine/bin/winpy"}
export LD_LIBRARY_PATH="$(dirname "$(dirname "$DXC")")/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

wine_path() { printf 'Z:%s' "$1" | tr / '\\'; }

# fxc <source> <profile> <out>: the program and its listing (<out>.ms.txt)
fxc() {
    $FXC /nologo /T "$2" /E main /Fo "$(wine_path "$here/$3")" /Fc "$(wine_path "$here/$3.ms.txt")" \
        "$(wine_path "$here/$1")" >/dev/null
    test -s "$here/$3" || { echo "fxc did not write $3" >&2; exit 1; }
    # fxc writes D3DDisassemble's listing in Windows text mode: the listing itself ends its lines with \n alone
    tr -d '\r' < "$here/$3.ms.txt" > "$here/$3.ms.tmp" && mv "$here/$3.ms.tmp" "$here/$3.ms.txt"
}

# dxc <source> <profile> <out>: the program and its -dumpbin listing
dxc() {
    $DXC -T "$2" -E main -Fo "$here/$3" "$here/$1"
    # stdout, as dx documents its oracle: -Fc writes one newline fewer at the end
    $DXC -dumpbin "$here/$3" > "$here/$3.ms.txt"
}

fxc plasma/plasma.hlsl ps_5_0 plasma/plasma.dxbc
fxc lit-brick/lit-brick.hlsl ps_5_0 lit-brick/lit-brick.dxbc
fxc d3d9-pair/d3d9-pair.vs.hlsl vs_3_0 d3d9-pair/d3d9-pair.vso
fxc d3d9-pair/d3d9-pair.ps.hlsl ps_3_0 d3d9-pair/d3d9-pair.pso
fxc d3d9-ps2/toon.hlsl ps_2_0 d3d9-ps2/toon.pso
fxc post/bloom-tonemap.hlsl ps_5_0 post/bloom-tonemap.dxbc
fxc compute-fractal/julia.hlsl cs_5_0 compute-fractal/julia.dxbc
dxc sdf-dxil/raymarch.hlsl ps_6_0 sdf-dxil/raymarch.dxil
dxc pbr-dxil/pbr.hlsl ps_6_0 pbr-dxil/pbr.dxil
dxc amplification/amplification.hlsl as_6_5 amplification/amplification.dxil

# pixel 1.1 has no HLSL compiler any more: D3DAssemble assembles it, and D3DDisassemble lists it
"$WINPY" "$(wine_path "$here/../../iridia-d3d9-ir/tests/oracles/assemble.py")" "$(wine_path "$D3DCOMPILER")" \
    "$(wine_path "$here/d3d9-ps1")" || true
mv "$here/d3d9-ps1/water.bin" "$here/d3d9-ps1/water.pso"
mv "$here/d3d9-ps1/water.dis" "$here/d3d9-ps1/water.pso.ms.txt"
echo "built the examples in $here"
