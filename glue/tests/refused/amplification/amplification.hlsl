// A Shader Model 6.5 amplification program: culls a group of meshlets against a plane and launches mesh groups for
// the survivors with a payload. WebGPU has no mesh pipeline, so the page shows the program, not a picture.
// dxc -T as_6_5 -E main amplification.hlsl
struct Payload
{
    uint meshlets[32];
};

cbuffer Culling : register(b0)
{
    float4 plane;
    uint meshletCount;
};

StructuredBuffer<float4> bounds : register(t0);

groupshared Payload payload;
groupshared uint survivors;

[numthreads(32, 1, 1)]
void main(uint thread : SV_GroupIndex, uint group : SV_GroupID)
{
    if (thread == 0)
        survivors = 0;
    GroupMemoryBarrierWithGroupSync();
    uint meshlet = group * 32 + thread;
    if (meshlet < meshletCount)
    {
        float4 sphere = bounds[meshlet];
        if (dot(plane.xyz, sphere.xyz) + plane.w > -sphere.w)
        {
            uint slot;
            InterlockedAdd(survivors, 1, slot);
            payload.meshlets[slot] = meshlet;
        }
    }
    GroupMemoryBarrierWithGroupSync();
    DispatchMesh(survivors, 1, 1, payload);
}
