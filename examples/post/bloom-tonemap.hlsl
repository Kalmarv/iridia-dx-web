// A Shader Model 5 post effect: a 13-tap bright-pass blur added back as bloom, ACES filmic tonemapping, a vignette and
// chromatic aberration, over an image.
// fxc /T ps_5_0 /E main bloom-tonemap.hlsl
cbuffer Post : register(b0)
{
    float  exposure = 1.2;          // 0.25 .. 4
    float  bloomThreshold = 0.6;    // 0 .. 1
    float  bloomStrength = 0.8;     // 0 .. 2
    float  bloomRadius = 2.5;       // 0.5 .. 8 texels
    float  vignette = 0.35;          // 0 .. 1
    float  aberration = 0.003;        // 0 .. 0.01
    float2 texelSize = float2(1.0 / 512.0, 1.0 / 512.0);         // 1 / image size
};

Texture2D image : register(t0);
SamplerState linearClamp : register(s0);

static const float2 taps[12] = {
    float2( 1, 0), float2(-1, 0), float2(0,  1), float2( 0, -1),
    float2( 1, 1), float2(-1, 1), float2(1, -1), float2(-1, -1),
    float2( 2, 0), float2(-2, 0), float2(0,  2), float2( 0, -2),
};

float3 aces(float3 x)
{
    return saturate((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

float3 bright(float2 uv)
{
    float3 c = image.Sample(linearClamp, uv).rgb;
    return max(c - bloomThreshold, 0.0);
}

float4 main(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    float2 centre = uv - 0.5;
    float2 shift = centre * aberration;
    float3 color;
    color.r = image.Sample(linearClamp, uv + shift).r;
    color.g = image.Sample(linearClamp, uv).g;
    color.b = image.Sample(linearClamp, uv - shift).b;

    float3 bloom = bright(uv);
    [unroll] for (int i = 0; i < 12; ++i)
        bloom += bright(uv + taps[i] * texelSize * bloomRadius) * (i < 8 ? 0.7 : 0.4);
    bloom /= 8.0;

    color = (color + bloom * bloomStrength) * exposure;
    color = aces(color);
    color *= 1.0 - vignette * dot(centre, centre) * 2.0;
    return float4(color, 1.0);
}
