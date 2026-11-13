// Default workflow definition; model selection is supplied at run time.
export const starterImageTool = {
  slug: 'image-creation',
  name: '图像生成',
  category: '图像生成',
  description: '描述生成图片；带参考图自动进入图生图，支持多张参考。',
  workflow: {
    nodes: [
      { id: 'up1', type: 'image-upload-batch', label: '参考图片', inputs: { images: [] }, x: 480, y: 160 },
      { id: 'g1', type: 'image-generate', label: '生成图片', inputs: { prompt: '', width: 1024, height: 1024, model: '' }, x: 940, y: 220 },
    ],
    connections: [
      { sourceNodeId: 'up1', sourcePort: 'images', targetNodeId: 'g1', targetPort: 'referenceImage' },
    ],
  },
  slots: [
    { id: 'text:g1', type: 'text', label: '画面描述', description: '描述你想要的画面', required: true, targets: [{ nodeId: 'g1', port: 'prompt' }], status: 'confirmed' },
    { id: 'model:g1', type: 'model', label: '生图模型', modelType: 'IMAGE', required: true, targets: [{ nodeId: 'g1', port: 'model' }], status: 'confirmed' },
    { id: 'upload:up1', type: 'upload', label: '参考图片', description: '可选：贴参考图即进入图生图（支持多张）', accept: ['image'], multiple: true, targets: [{ nodeId: 'up1', port: 'images' }], status: 'confirmed' },
    { id: 'ratio:g1', type: 'ratio', label: '图片规格', defaultRatio: '1:1', defaultTier: '1K', targets: [{ nodeId: 'g1', port: 'width' }, { nodeId: 'g1', port: 'height' }], status: 'confirmed' },
    { id: 'result:main', type: 'result', label: '生成结果', targets: [{ nodeId: 'g1', port: 'imageUrl' }], status: 'confirmed' },
  ],
}
