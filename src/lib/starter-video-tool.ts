// Default workflow definition; model selection is supplied at run time.
export const starterVideoTool = {
  slug: 'video-creation',
  name: '视频生成',
  category: '视频生成',
  description: '一句话生成短视频；也可以上传参考图（1–9 张）或首尾帧。生成方式由所选模型支持的能力决定。',
  workflow: {
    nodes: [
      { id: 'up1', type: 'image-upload-batch', label: '参考图片', inputs: { images: [] }, x: 480, y: 80 },
      { id: 'f1', type: 'image-upload', label: '首帧图片', inputs: { image: '' }, x: 480, y: 240 },
      { id: 'f2', type: 'image-upload', label: '尾帧图片', inputs: { image: '' }, x: 480, y: 400 },
      { id: 'au1', type: 'audio-upload', label: '参考音频', inputs: { audio: '' }, x: 480, y: 560 },
      { id: 'vi1', type: 'video-upload', label: '参考视频', inputs: { video: '' }, x: 480, y: 700 },
      { id: 'v1', type: 'video-generate', label: '生成视频', inputs: { prompt: '', aspectRatio: '16:9', model: '' }, x: 940, y: 280 },
    ],
    connections: [
      { sourceNodeId: 'up1', sourcePort: 'images', targetNodeId: 'v1', targetPort: 'referenceImage' },
      { sourceNodeId: 'f1', sourcePort: 'imageUrl', targetNodeId: 'v1', targetPort: 'firstFrame' },
      { sourceNodeId: 'f2', sourcePort: 'imageUrl', targetNodeId: 'v1', targetPort: 'lastFrame' },
      { sourceNodeId: 'au1', sourcePort: 'audio', targetNodeId: 'v1', targetPort: 'referenceAudio' },
      { sourceNodeId: 'vi1', sourcePort: 'video', targetNodeId: 'v1', targetPort: 'referenceVideo' },
    ],
  },
  slots: [
    { id: 'text:prompt', type: 'text', label: '视频描述', description: '描述主体、动作、场景、镜头运动', required: true, targets: [{ nodeId: 'v1', port: 'prompt' }], status: 'confirmed' },
    { id: 'model:v1', type: 'model', label: '视频模型', modelType: 'VIDEO', required: true, targets: [{ nodeId: 'v1', port: 'model' }], status: 'confirmed' },
    { id: 'upload:up1', type: 'upload', label: '参考图片', description: '上传 1–9 张参考图（全能参考方式）', accept: ['image'], multiple: true, videoModeOnly: 'multiReference', targets: [{ nodeId: 'up1', port: 'images' }], status: 'confirmed' },
    { id: 'upload:f1', type: 'upload', label: '首帧图片', description: '视频起始画面（首尾帧方式必填）', accept: ['image'], videoModeOnly: 'firstLastFrame', targets: [{ nodeId: 'f1', port: 'image' }], status: 'confirmed' },
    { id: 'upload:f2', type: 'upload', label: '尾帧图片', description: '视频结束画面（首尾帧方式必填）', accept: ['image'], videoModeOnly: 'firstLastFrame', targets: [{ nodeId: 'f2', port: 'image' }], status: 'confirmed' },
    { id: 'upload:au1', type: 'upload', label: '参考音频', description: '可选：音色 / 配乐 / 节奏参考（全能参考方式）', accept: ['audio'], videoModeOnly: 'multiReference', targets: [{ nodeId: 'au1', port: 'audio' }], status: 'confirmed' },
    { id: 'upload:vi1', type: 'upload', label: '参考视频', description: '可选：动作 / 运镜参考（仅部分上游支持，全能参考方式）', accept: ['video'], videoModeOnly: 'multiReference', targets: [{ nodeId: 'vi1', port: 'video' }], status: 'confirmed' },
    { id: 'ratio:v1', type: 'ratio', label: '视频画幅', defaultRatio: '16:9', targets: [{ nodeId: 'v1', port: 'aspectRatio' }], status: 'confirmed' },
    { id: 'result:main', type: 'result', label: '生成结果', targets: [{ nodeId: 'v1', port: 'videoUrl' }], status: 'confirmed' },
  ],
}
