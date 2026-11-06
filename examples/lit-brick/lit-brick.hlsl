// A lit, normal-mapped surface: a brick normal map and albedo, Blinn-Phong lighting, with two feature switches
// (normal mapping, specular) that iridia's specialisation folds when they are pinned.
// fxc /T ps_5_0 /E main lit-brick.hlsl
cbuffer Material : register(b0)
{
    float3 lightDirection = float3(0.45, 0.7, 0.55);   // towards the light, world space
    float  shininess = 48.0;        // 4 .. 128
    float3 lightColor = float3(1.0, 0.95, 0.88);
    float  ambient = 0.15;          // 0 .. 0.5
    float3 eyePosition = float3(0.0, 0.0, 3.0);      // world space
    uint   useNormalMap = 1;     // 0 or 1
    float  bumpStrength = 1.0;     // 0 .. 2
    uint   useSpecular = 1;      // 0 or 1
    float2 tiling = float2(2.0, 2.0);           // UV repeats
};

Texture2D albedoMap : register(t0);
Texture2D normalMap : register(t1);
SamplerState linearRepeat : register(s0);

struct PixelIn
{
    float4 position : SV_Position;
    float3 worldPosition : POSITION1;
    float3 normal : NORMAL;
    float4 tangent : TANGENT;
    float2 uv : TEXCOORD0;
};

float4 main(PixelIn i) : SV_Target
{
    float2 uv = i.uv * tiling;
    float3 n = normalize(i.normal);
    if (useNormalMap != 0)
    {
        float3 t = normalize(i.tangent.xyz - n * dot(n, i.tangent.xyz));
        float3 b = cross(n, t) * i.tangent.w;
        float3 m = normalMap.Sample(linearRepeat, uv).xyz * 2.0 - 1.0;
        m.xy *= bumpStrength;
        n = normalize(m.x * t + m.y * b + m.z * n);
    }
    float3 l = normalize(lightDirection);
    float3 albedo = albedoMap.Sample(linearRepeat, uv).rgb;
    float diffuse = saturate(dot(n, l));
    float3 color = albedo * (ambient + diffuse * lightColor);
    if (useSpecular != 0)
    {
        float3 v = normalize(eyePosition - i.worldPosition);
        float3 h = normalize(l + v);
        color += lightColor * pow(saturate(dot(n, h)), shininess) * (diffuse > 0.0 ? 1.0 : 0.0);
    }
    return float4(color, 1.0);
}
