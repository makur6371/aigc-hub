'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Form, InputNumber, Button, Typography, Space, App, Spin } from 'antd'
import { SafetyOutlined, SaveOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'

const { Text } = Typography

export function VerificationPolicyPanel() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [fetchLoading, setFetchLoading] = useState(true)

  const fetchPolicy = useCallback(async () => {
    setFetchLoading(true)
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/admin/verification-policy')
      if (res.success && res.data) {
        form.setFieldsValue(res.data)
      }
    } catch { /* */ } finally {
      setFetchLoading(false)
    }
  }, [form])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchPolicy(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchPolicy])

  const handleSave = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/verification-policy', {
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
    <Card variant="outlined" title={<Space><SafetyOutlined />注册与验证策略</Space>}>
      <Spin spinning={fetchLoading}>
      <Text className="text-xs text-text-secondary block mb-4">
        配置邮箱验证码的有效时间和重发间隔,防止刷接口。
      </Text>

      <Form form={form} layout="vertical" className="max-w-sm">
        <Form.Item
          name="codeExpiryMinutes"
          label="验证码有效时间(分钟)"
          rules={[{ required: true, message: '请输入有效时间' }]}
        >
          <InputNumber min={1} max={60} className="w-full" placeholder="默认 10 分钟" />
        </Form.Item>

        <Form.Item
          name="resendCooldownSec"
          label="重发冷却间隔(秒)"
          rules={[{ required: true, message: '请输入冷却间隔' }]}
        >
          <InputNumber min={10} max={600} className="w-full" placeholder="默认 60 秒" />
        </Form.Item>

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>
            保存策略
          </Button>
        </Form.Item>
      </Form>
      </Spin>
    </Card>
  )
}
