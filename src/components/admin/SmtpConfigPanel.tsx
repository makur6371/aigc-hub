'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Form, Input, InputNumber, Button, Typography, Space, App, Divider, Spin } from 'antd'
import { MailOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import { ORG } from '@/lib/site-content'

const { Text } = Typography

export function SmtpConfigPanel() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [fetchLoading, setFetchLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testEmail, setTestEmail] = useState('')

  const fetchConfig = useCallback(async () => {
    setFetchLoading(true)
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/admin/smtp-config')
      if (res.success && res.data) {
        form.setFieldsValue(res.data)
      }
    } catch { /* */ } finally {
      setFetchLoading(false)
    }
  }, [form])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchConfig(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchConfig])

  const handleSave = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/smtp-config', {
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

  const handleTest = async () => {
    if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      message.error('请输入有效的测试邮箱')
      return
    }
    setTesting(true)
    try {
      const res = await apiFetch('/api/admin/smtp-config', {
        method: 'POST',
        body: JSON.stringify({ testEmail }),
      })
      if (res.success) message.success('测试邮件发送成功,请查收')
      else message.error(res.message)
    } catch {
      message.error('测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card variant="outlined" title={<Space><MailOutlined />SMTP 发件配置</Space>}>
      <Spin spinning={fetchLoading}>
      <Text className="text-xs text-text-secondary block mb-4">
        配置后,系统可通过该邮箱发送注册验证码。QQ 邮箱请使用授权码而非登录密码。
      </Text>

      <Form form={form} layout="vertical" className="max-w-lg">
        <div className="grid grid-cols-2 gap-4">
          <Form.Item name="host" label="SMTP 主机" rules={[{ required: true, message: '请输入主机地址' }]}>
            <Input placeholder="smtp.qq.com" />
          </Form.Item>
          <Form.Item name="port" label="SMTP 端口" rules={[{ required: true, message: '请输入端口' }]}>
            <InputNumber min={1} max={65535} className="w-full" placeholder="465(SSL) 或 587(TLS)" />
          </Form.Item>
        </div>

        <Form.Item name="username" label="SMTP 用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input placeholder="通常为您的邮箱地址" />
        </Form.Item>

        <Form.Item name="password" label="SMTP 密码/授权码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="QQ邮箱为16位授权码" />
        </Form.Item>

        <div className="grid grid-cols-2 gap-4">
          <Form.Item name="senderEmail" label="发件人邮箱" rules={[{ required: true, message: '请输入发件人邮箱' }]}>
            <Input placeholder="noreply@example.com" />
          </Form.Item>
          <Form.Item name="senderName" label="发件人显示名称">
            <Input placeholder={ORG.name} />
          </Form.Item>
        </div>

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>
            保存配置
          </Button>
        </Form.Item>
      </Form>

      <Divider />

      <div className="max-w-lg">
        <Text strong className="text-sm block mb-2">测试发件</Text>
        <Space.Compact className="w-full">
          <Input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="输入测试接收邮箱" />
          <Button icon={<SendOutlined />} onClick={handleTest} loading={testing}>
            发送测试邮件
          </Button>
        </Space.Compact>
      </div>
      </Spin>
    </Card>
  )
}
