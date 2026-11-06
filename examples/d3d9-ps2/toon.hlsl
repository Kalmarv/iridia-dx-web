// A ps_2_0 program in the Direct3D 9 style: posterises the texture into bands, then outlines its edges with a
// four-tap luminance difference.
// fxc /T ps_2_0 /E main toon.hlsl
sampler2D image : register(s0);
float bands = 4.0;
float edgeThreshold = 0.12;
float2 texelSize = float2(1.0 / 256.0, 1.0 / 256.0);
float4 inkColor = float4(0.06, 0.05, 0.1, 1.0);

float luminance(float3 c) { return dot(c, float3(0.299, 0.587, 0.114)); }

float4 main(float2 uv : TEXCOORD0) : COLOR0
{
    float3 c = tex2D(image, uv).rgb;
    float3 posterised = floor(c * bands + 0.5) / bands;
    float l = luminance(tex2D(image, uv + float2(texelSize.x, 0)).rgb);
    float r = luminance(tex2D(image, uv - float2(texelSize.x, 0)).rgb);
    float u = luminance(tex2D(image, uv + float2(0, texelSize.y)).rgb);
    float d = luminance(tex2D(image, uv - float2(0, texelSize.y)).rgb);
    float edge = abs(l - r) + abs(u - d);
    return edge > edgeThreshold ? inkColor : float4(posterised, 1.0);
}
