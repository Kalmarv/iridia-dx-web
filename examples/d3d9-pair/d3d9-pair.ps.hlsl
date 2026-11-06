// Its pixel program: the texture times the vertex lighting, with a rim term from the interpolated normal.
// fxc /T ps_3_0 /E main d3d9-pair.ps.hlsl
sampler2D diffuseMap : register(s0);
float3 rimColor = float3(1.0, 0.75, 0.4);
float rimPower = 3.0;

float4 main(float2 uv : TEXCOORD0, float3 normal : TEXCOORD1, float4 light : COLOR0) : COLOR0
{
    float3 albedo = tex2D(diffuseMap, uv).rgb;
    float rim = pow(1.0 - saturate(abs(normalize(normal).z)), rimPower);
    return float4(albedo * light.rgb + rim * rimColor, 1.0);
}
