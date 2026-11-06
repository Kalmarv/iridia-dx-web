// A Shader Model 6 physically based material: GGX specular with Smith visibility and Schlick Fresnel, Lambert
// diffuse, two lights and a sky ambient, with metalness and roughness from the constant buffer.
// dxc -T ps_6_0 -E main pbr.hlsl
cbuffer Material : register(b0)
{
    float3 baseColor;
    float  roughness;      // 0.04 .. 1
    float3 eyePosition;
    float  metalness;      // 0 .. 1
    float3 keyLightDirection;
    float  keyLightIntensity;  // 0 .. 8
    float3 keyLightColor;
    float  fillLightIntensity; // 0 .. 4
    float3 skyColor;
    float  exposure;       // 0.25 .. 4
};

Texture2D albedoMap : register(t0);
SamplerState linearRepeat : register(s0);

static const float PI = 3.14159265;

float3 fresnel(float3 f0, float vh) { return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }

float ggx(float nh, float a)
{
    float a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

float smith(float nv, float nl, float a)
{
    float k = a * 0.5;
    return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}

float3 shade(float3 n, float3 v, float3 l, float3 radiance, float3 albedo, float3 f0, float a)
{
    float3 h = normalize(v + l);
    float nl = saturate(dot(n, l));
    float nv = max(dot(n, v), 1e-4);
    float nh = saturate(dot(n, h));
    float3 f = fresnel(f0, saturate(dot(v, h)));
    float3 specular = ggx(nh, a) * smith(nv, nl, a) * f / max(4.0 * nv * nl, 1e-4);
    float3 diffuse = (1.0 - f) * (1.0 - metalness) * albedo / PI;
    return (diffuse + specular) * radiance * nl;
}

float4 main(float4 position : SV_Position, float3 worldPosition : POSITION1, float3 normal : NORMAL,
            float2 uv : TEXCOORD0) : SV_Target
{
    float3 n = normalize(normal);
    float3 v = normalize(eyePosition - worldPosition);
    float3 albedo = baseColor * albedoMap.Sample(linearRepeat, uv).rgb;
    float a = roughness * roughness;
    float3 f0 = lerp(float3(0.04, 0.04, 0.04), albedo, metalness);
    float3 color = shade(n, v, normalize(keyLightDirection), keyLightColor * keyLightIntensity, albedo, f0, a);
    color += shade(n, v, normalize(float3(-0.6, 0.2, -0.5)), float3(0.6, 0.7, 1.0) * fillLightIntensity, albedo, f0, a);
    color += skyColor * albedo * (0.5 + 0.5 * n.y) * (1.0 - metalness * 0.5);
    color *= exposure;
    color = color / (1.0 + color);
    return float4(pow(color, 1.0 / 2.2), 1.0);
}
