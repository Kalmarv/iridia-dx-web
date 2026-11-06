// An animated plasma: sums of sines over the pixel's position, mapped through a two-colour palette.
// fxc /T ps_5_0 /E main plasma.hlsl
cbuffer Plasma : register(b0)
{
    float  time = 0.0;        // seconds
    float  speed = 1.0;       // 0.2 .. 3
    float  scale = 6.0;       // 1 .. 12
    float  sharpness = 1.5;   // 0.5 .. 4
    float3 colorA = float3(209.0 / 255.0, 213.0 / 255.0, 1.0);          // #d1d5ff
    float3 colorB = float3(104.0 / 255.0, 211.0 / 255.0, 238.0 / 255.0); // #68d3ee
};

float4 main(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    float2 p = (uv - 0.5) * scale;
    float t = time * speed;
    float v = sin(p.x + t);
    v += sin((p.y + t) * 0.5);
    v += sin((p.x + p.y + t) * 0.5);
    float2 c = p + 0.5 * float2(sin(t / 5.0), cos(t / 3.0)) * scale;
    v += sin(sqrt(dot(c, c) + 1.0) + t);
    v *= 0.5;
    float k = pow(0.5 + 0.5 * sin(v * 3.14159265), sharpness);
    float3 rgb = lerp(colorA, colorB, k);
    rgb += 0.15 * float3(sin(v * 6.2831), sin(v * 6.2831 + 2.094), sin(v * 6.2831 + 4.188));
    return float4(saturate(rgb), 1.0);
}
