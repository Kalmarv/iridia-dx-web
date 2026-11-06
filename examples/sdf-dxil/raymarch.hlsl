// A Shader Model 6 program: sphere-traces a small signed-distance scene (a twisting torus over a plane) with soft
// shadows and ambient occlusion, in a loop with an early exit.
// dxc -T ps_6_0 -E main raymarch.hlsl
cbuffer Scene : register(b0)
{
    float  time;
    float  twist;          // 0 .. 4
    float  shadowSoftness; // 2 .. 32
    uint   maxSteps;       // 16 .. 128
    float3 baseColor;
    float  fieldOfView;    // 0.5 .. 2
    float2 mouse;          // 0 .. 1, orbit
};

float sdTorus(float3 p, float2 t)
{
    float2 q = float2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
}

float3 rotateY(float3 p, float a)
{
    float s = sin(a), c = cos(a);
    return float3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

float scene(float3 p)
{
    float3 q = rotateY(p - float3(0, 1.0, 0), p.y * twist + time * 0.7);
    q = float3(q.x, q.z, q.y);
    float torus = sdTorus(q, float2(0.8, 0.28));
    float plane = p.y + 0.05 * sin(p.x * 3.0) * sin(p.z * 3.0);
    return min(torus, plane);
}

float3 normalAt(float3 p)
{
    const float2 e = float2(0.002, 0);
    return normalize(float3(scene(p + e.xyy) - scene(p - e.xyy),
                            scene(p + e.yxy) - scene(p - e.yxy),
                            scene(p + e.yyx) - scene(p - e.yyx)));
}

float softShadow(float3 origin, float3 dir)
{
    float result = 1.0;
    float t = 0.02;
    for (uint i = 0; i < 48; ++i)
    {
        float h = scene(origin + dir * t);
        result = min(result, shadowSoftness * h / t);
        t += clamp(h, 0.02, 0.25);
        if (result < 0.001 || t > 8.0)
            break;
    }
    return saturate(result);
}

float4 main(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    float yaw = (mouse.x - 0.5) * 6.2831853 + time * 0.1;
    float3 eye = float3(sin(yaw) * 4.0, 1.6 + (mouse.y - 0.5) * 2.0, cos(yaw) * 4.0);
    float3 forward = normalize(float3(0, 0.8, 0) - eye);
    float3 right = normalize(cross(float3(0, 1, 0), forward));
    float3 up = cross(forward, right);
    float2 ndc = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    float3 dir = normalize(forward + (ndc.x * right + ndc.y * up) * fieldOfView * 0.5);

    float t = 0.0;
    bool hit = false;
    for (uint i = 0; i < maxSteps; ++i)
    {
        float d = scene(eye + dir * t);
        if (d < 0.001)
        {
            hit = true;
            break;
        }
        t += d;
        if (t > 20.0)
            break;
    }

    float3 sky = lerp(float3(0.75, 0.82, 0.95), float3(0.25, 0.4, 0.75), saturate(dir.y * 1.5));
    if (!hit)
        return float4(sky, 1.0);

    float3 p = eye + dir * t;
    float3 n = normalAt(p);
    float3 light = normalize(float3(0.6, 0.9, 0.3));
    float diffuse = saturate(dot(n, light)) * softShadow(p + n * 0.01, light);
    float occlusion = saturate(0.5 + 0.5 * scene(p + n * 0.15) / 0.15);
    float3 albedo = p.y < 0.2 ? lerp(float3(0.3, 0.3, 0.32), float3(0.5, 0.5, 0.52), step(0.0, sin(p.x * 4.0) * sin(p.z * 4.0))) : baseColor;
    float3 color = albedo * (0.2 * occlusion * sky + diffuse * float3(1.0, 0.95, 0.85));
    color = lerp(color, sky, saturate(t / 20.0));
    return float4(pow(color, 1.0 / 2.2), 1.0);
}
