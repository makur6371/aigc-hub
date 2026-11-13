'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Form, Select, Button, Typography, Space, App, Spin } from 'antd'
import { RobotOutlined, SaveOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'

const { Text } = Typography

interface ModelOption {
  id: string
  name: string
  type: string
  isFree: boolean
  isActive: boolean
  provider?: { isActive?: boolean } | null
}

export function AgentConfigPanel() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [fetchLoading, setFetchLoading] = useState(true)
  // 选项列表是否已加载完成：用于「先拿选项、再回填表单值」的时序保护
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  // 已保存的配置先存住，等选项列表就绪后再回填表单。
  //
  // 为什么必须分开：以前是「配置一到就 setFieldsValue，选项可能还没到」，
  // 此时 Select 找不到能匹配 value 的 option，会把原始 model id（一串 cuid）
  // 当文本直接显示出来 —— 用户看到的就是「配置项变成乱码 id」。
  // 两个请求并发、先后顺序不定，所以这现象是偶发的（刷新几次可能就好）。
  const [savedCfg, setSavedCfg] = useState<{ planningModelId: string | null; planningBackupModelIds: string[] } | null>(null)

  const fetchAll = useCallback(async () => {
    setFetchLoading(true)
    try {
      const [cfgRes, modelsRes] = await Promise.all([
        apiFetch<{ planningModelId: string | null; planningBackupModelIds?: string[] }>('/api/admin/agent-config'),
        apiFetch<ModelOption[]>('/api/admin/models'),
      ])
      if (cfgRes.success && cfgRes.data) {
        setSavedCfg({
          planningModelId: cfgRes.data.planningModelId ?? null,
          planningBackupModelIds: cfgRes.data.planningBackupModelIds ?? [],
        })
      }
      if (modelsRes.success && modelsRes.data) {
        const list = (modelsRes.data || []).filter(
          (m) => (m.type === 'TEXT' || m.type === 'VISION') && m.isActive !== false && m.provider?.isActive !== false,
        )
        setModels(list)
      }
    } catch { /* */ } finally {
      setModelsLoaded(true)
      setFetchLoading(false)
    }
  }, [])

  // 选项就绪后才回填表单值：保证 value 一定能匹配到 option，
  // 不会出现「先渲染裸 id、再变回中文名」的闪烁。
  useEffect(() => {
    if (!savedCfg || !modelsLoaded) return
    form.setFieldsValue({
      planningModelId: savedCfg.planningModelId,
      planningBackupModelIds: savedCfg.planningBackupModelIds,
    })
  }, [savedCfg, modelsLoaded, form])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchAll(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchAll])

  /**
   * 下拉选项 = 可选模型 + 「已保存但当前不可用」的兜底项。
   *
   * 场景：admin 选的模型后来被停用/删除了，配置里还留着那个 id。
   * 若不给它一个 option，Select 会把这串 cuid 原样显示出来 —— 看起来像坏掉。
   * 补一个禁用项，标签写成「xxx（已停用）」，用户能看懂发生了什么。
   */
  const modelOptions = (() => {
    const opts = models.map((m) => ({
      value: m.id,
      label: `${m.name}${m.isFree ? '（免费）' : ''}`,
      disabled: m.isActive === false,
    }))
    const known = new Set(opts.map((o) => o.value))
    const savedIds = [
      ...(savedCfg?.planningModelId ? [savedCfg.planningModelId] : []),
      ...(savedCfg?.planningBackupModelIds ?? []),
    ]
    for (const id of savedIds) {
      if (!known.has(id)) {
        opts.push({ value: id, label: `${id}（已停用或不存在）`, disabled: true })
        known.add(id)
      }
    }
    return opts
  })()

  const handleSave = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/agent-config', {
        method: 'PUT',
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success(res.message || '保存成功')
      } else {
        message.error(res.message || '保存失败')
      }
    } catch {
      message.error('保存失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card variant="outlined" title={<Space><RobotOutlined />Auto-LLM 配置</Space>}>
      <Spin spinning={fetchLoading}>
      <Text className="text-xs text-text-secondary block mb-4">
        Auto-LLM 会用于 Agent 规划和工具里的文本/多模态节点。主模型失败/超时后按「替补链」顺序自动切换。
        <b>这里配了哪几个，就只会用哪几个</b>；一个都不配时，才会自动使用其余已启用的免费 TEXT 模型兜底。
      </Text>

      <Form form={form} layout="vertical" className="max-w-sm">
        <Form.Item name="planningModelId" label="Auto-LLM 主模型（TEXT / VISION）">
          <Select
            allowClear
            loading={fetchLoading}
            placeholder="自动选择（免费优先）"
            options={modelOptions}
          />
        </Form.Item>

        {/* 替补链：有序多选。用 mode=multiple 会丢失顺序语义，所以用「拖动排序」的标签式展示 */}
        <Form.Item
          name="planningBackupModelIds"
          label="Auto-LLM 替补链（失败后按顺序切换）"
          tooltip="按从上到下的顺序依次尝试。留空则自动使用其余已启用的免费模型。"
        >
          <Select
            mode="multiple"
            allowClear
            loading={fetchLoading}
            placeholder="不配置则自动降级"
            options={modelOptions}
          />
        </Form.Item>

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>
            保存配置
          </Button>
        </Form.Item>
      </Form>
      </Spin>
    </Card>
  )
}
