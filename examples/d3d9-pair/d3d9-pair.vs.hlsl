// A classic Direct3D 9 vertex program: transforms by a world-view-projection matrix, lights per vertex with a
// hemisphere ambient and one directional light, and passes on the texture coordinate, the normal and the direction
// to the eye.
// fxc /T vs_3_0 /E main d3d9-pair.vs.hlsl
float4x4 worldViewProjection;
float4x4 world;
float3 eyePosition;
float3 lightDirection = float3(0.4, 0.8, 0.45);
float3 lightColor = float3(0.8, 0.76, 0.7);
float3 skyColor = float3(0.35, 0.45, 0.65);
float3 groundColor = float3(0.18, 0.12, 0.08);
float uvScale = 2.0;

struct VertexIn
{
    float4 position : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD0;
};

struct VertexOut
{
    float4 position : POSITION;
    float2 uv : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float3 view : TEXCOORD2;
    float4 light : COLOR0;
};

VertexOut main(VertexIn v)
{
    VertexOut o;
    o.position = mul(v.position, worldViewProjection);
    float3 n = normalize(mul(v.normal, (float3x3)world));
    float hemisphere = n.y * 0.5 + 0.5;
    float3 light = lerp(groundColor, skyColor, hemisphere) + lightColor * saturate(dot(n, normalize(lightDirection)));
    o.uv = v.uv * uvScale;
    o.normal = n;
    o.view = eyePosition - mul(v.position, world).xyz;
    o.light = float4(light, 1.0);
    return o;
}
