'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Button, Modal, Input, Select, App, Typography, Popconfirm } from 'antd'
import { ApiOutlined, CopyOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import { ORG } from '@/lib/site-content'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'

const { Text, Paragraph } = Typography

type PairingItem = {
  id: string
  name: string
  codeTail: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  lastUsedIp: string | null
  createdAt: string
}

type CreatedPairing = {
  id: string
  name: string
  code: string
  expiresAt: string
}

export function McpPairingCard() {
  const { message } = App.useApp()
  const [items, setItems] = useState<PairingItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [created, setCreated] = useState<CreatedPairing | null>(null)
  const [days, setDays] = useState<number>(90)

  const guideText = (c: CreatedPairing): string => {
    const url = 'http://localhost:3000/api/mcp'
    return `# ${ORG.name}画布 MCP 接入说明

## 1. 配对码（明文仅显示一次，请妥善保存）
${c.code}
（备注：${c.name}｜有效期至 ${c.expiresAt}）

## 2. 接入方法
MCP 服务器（Streamable HTTP）：${url}
鉴权：请求头 Authorization: Bearer <上面的配对码>

- Claude Code / 千问 Qwen Code 终端一键接入：
  claude mcp add --transport http aigc-hub ${url} \\
    --header "Authorization: Bearer ${c.code}"
- OpenAI Codex CLI（~/.codex/config.toml）：
  [mcp_servers.aigc-hub]
  url = "${url}"
  http_headers = { Authorization = "Bearer ${c.code}" }
- 其他客户端：任何支持远程 MCP + 自定义请求头的客户端，URL 和请求头同上。

连上后即可用 9 个工具操作画布：list_workflows / get_workflow / create_workflow /
update_workflow / run_workflow / get_run / cancel_run / list_node_types / list_models。
改工作流前先 get_workflow 拿最新整包；配对码泄露或不用时到 MCP 连接页撤销。

## 3. 保存为 Skill（推荐）
把下面内容保存为 Skill（Claude Code 存到 ~/.claude/skills/aigc-hub/SKILL.md），
以后对 Agent 说「连接我的${ORG.name.replace(/\s/g, '')}画布」即可自动完成接入：

---
name: aigc-hub
description: 连接${ORG.name}画布 MCP（原 AIGC Hub），用 9 个工具创建/运行 AI 工作流（文生图、LLM、视频、批量提示词等）
---

# ${ORG.name}画布

1. 若尚未接入，运行：
   claude mcp add --transport http aigc-hub ${url} --header "Authorization: Bearer ${c.code}"
2. 用 list_node_types 和 list_models 了解可用节点与模型。
3. 用 create_workflow（nodes + connections 数组）搭工作流，run_workflow 运行并等待结果，
   outputs 里是各节点输出（图片看 imageUrl 字段）。
4. 整包读写：修改前先 get_workflow 再 update_workflow。
5. 配对码：${c.code}
`
  }

  const copyAll = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(guideText(created))
      message.success('说明书已复制，发给你的 Agent 即可')
    } catch {
      message.warning('复制失败，请手动全选复制')
    }
  }

  // 一键把配置写进剪贴板：国内非开发用户也能「复制 → 粘贴进客户端设置」完成接入
  const copySnippet = async (text: string, tip: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(tip)
    } catch {
      message.warning('复制失败，请手动全选复制')
    }
  }

  const MCP_URL = 'http://localhost:3000/api/mcp'

  /** 下载各客户端可直接导入的 MCP 配置文件（JSON / TOML），免手写 */
  const downloadConfig = (kind: 'claude' | 'codex' | 'cursor') => {
    if (!created) return
    const cfg =
      kind === 'codex'
        ? `[mcp_servers.aigc-hub]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${created.code}" }\n`
        : JSON.stringify(
            {
              mcpServers: {
                'aigc-hub': {
                  type: 'http',
                  url: MCP_URL,
                  headers: { Authorization: `Bearer ${created.code}` },
                },
              },
            },
            null,
            2,
          )
    const name = kind === 'codex' ? 'config.toml' : kind === 'cursor' ? 'mcp.json' : '.mcp.json'
    const blob = new Blob([cfg], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    message.success(`已下载 ${name}，按下方说明放到对应目录即可`)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<PairingItem[]>('/api/user/mcp/pairing')
      if (res.success) {
        setItems(res.data || [])
      } else {
        message.error(res.message || '配对码加载失败')
      }
    } catch {
      message.error('配对码加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await load()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await apiFetch<CreatedPairing>('/api/user/mcp/pairing', {
        method: 'POST',
        body: JSON.stringify({ name: nameInput || undefined, days }),
      })
      if (res.success && res.data) {
        setCreated(res.data)
        setNameInput('')
        setModalOpen(false)
        await load()
      } else {
        message.error(res.message || '配对码生成失败')
      }
    } catch {
      message.error('配对码生成失败')
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    try {
      const res = await apiFetch('/api/user/mcp/pairing', {
        method: 'DELETE',
        body: JSON.stringify({ id }),
      })
      if (res.success) {
        message.success('已撤销')
        await load()
      } else {
        message.error(res.message || '撤销失败')
      }
    } catch {
      message.error('撤销失败')
    }
  }

  const copyCode = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.code)
      message.success('配对码已复制')
    } catch {
      message.warning('复制失败，请手动选中复制')
    }
  }

  const toneOf = (p: PairingItem): StatusTone => {
    if (p.revokedAt) return 'danger'
    if (dayjs(p.expiresAt).isBefore(dayjs())) return 'warning'
    return 'success'
  }

  const labelOf = (p: PairingItem): string => {
    if (p.revokedAt) return '已撤销'
    if (dayjs(p.expiresAt).isBefore(dayjs())) return '已过期'
    return '生效中'
  }

  const columns: ColumnsType<PairingItem> = [
    { title: '备注', dataIndex: 'name', width: 160, ellipsis: true },
    {
      title: '配对码',
      dataIndex: 'codeTail',
      width: 120,
      render: (tail: string) => <Text code>····{tail}</Text>,
    },
    { title: '状态', width: 90, render: (_, p) => <StatusTag tone={toneOf(p)}>{labelOf(p)}</StatusTag> },
    {
      title: '有效期至',
      dataIndex: 'expiresAt',
      width: 120,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: '最近使用',
      width: 170,
      render: (_, p) =>
        p.lastUsedAt
          ? `${dayjs(p.lastUsedAt).format('MM-DD HH:mm')}${p.lastUsedIp ? ` · ${p.lastUsedIp}` : ''}`
          : '从未使用',
    },
    {
      title: '操作',
      width: 80,
      render: (_, p) =>
        p.revokedAt ? null : (
          <Popconfirm title="撤销后使用该配对码的 Agent 将立即断开，确认？" onConfirm={() => handleRevoke(p.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              撤销
            </Button>
          </Popconfirm>
        ),
    },
  ]

  return (
    <Card
      variant="outlined"
      title={<><ApiOutlined className="mr-2" />MCP 配对码</>}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          一键接入 Agent
        </Button>
      }
    >
      <Text type="secondary" className="block mb-4">
        生成配对码后，可在 Claude Code / Codex / 千问等支持 MCP 的 Agent 中连接你的画布。
        配对码明文仅在生成时展示一次，请妥善保存；泄露或不用时请及时撤销。
        <a href="/mcp" target="_blank" rel="noreferrer" className="ml-1">接入指南 →</a>
      </Text>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: '还没有配对码，点击右上角生成' }}
      />

      <Modal
        title="一键接入编程 Agent"
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => setModalOpen(false)}
        confirmLoading={creating}
        okText="生成接入说明"
        destroyOnHidden
      >
        <Input
          placeholder="密钥名字（如「我的笔记本 Claude Code」）"
          value={nameInput}
          maxLength={30}
          onChange={(e) => setNameInput(e.target.value)}
          onPressEnter={handleCreate}
        />
        <div className="mt-3 flex items-center gap-2">
          <span className="text-sm">有效期</span>
          <Select
            value={days}
            style={{ width: 140 }}
            onChange={(v) => setDays(v)}
            options={[
              { value: 7, label: '7 天' },
              { value: 30, label: '30 天' },
              { value: 90, label: '90 天' },
              { value: 365, label: '365 天' },
            ]}
          />
        </div>
        <Text type="secondary" className="block mt-3 text-xs">
          生成后会给出一份「接入说明书」：配对码 + 各端配置 + 可保存的 Skill，一键复制给 Agent 即可接入。最多同时 10 个生效配对码。
        </Text>
      </Modal>

      <Modal
        title="接入说明书（复制给你的 Agent）"
        open={!!created}
        onCancel={() => setCreated(null)}
        width={720}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={copyAll}>
            一键复制说明书
          </Button>,
          <Button key="code" icon={<CopyOutlined />} onClick={copyCode}>
            只复制配对码
          </Button>,
          <Button key="close" onClick={() => setCreated(null)}>我已保存</Button>,
        ]}
      >
        <Paragraph type="warning" className="mb-3">
          配对码明文仅显示这一次。把下方说明书发给任意 Agent（Claude Code / Codex / 千问等），
          它会照着完成接入；也可以自己照抄第 2 节配置。建议同时把第 3 节保存为 Skill，以后一句话即可重连。
        </Paragraph>

        {/* 不会用命令行的用户：直接复制 JSON/TOML 或下载配置文件，粘贴进客户端设置即可 */}
        {created && (
          <div className="mb-3 rounded-lg border border-border bg-surface p-3">
            <Text strong className="block mb-2 text-sm">不想敲命令？两种更省事的做法</Text>
            <div className="flex flex-wrap gap-2 mb-2">
              <Button size="small" icon={<CopyOutlined />} onClick={() => copySnippet(
                JSON.stringify({ mcpServers: { 'aigc-hub': { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${created.code}` } } } }, null, 2),
                '已复制 JSON 配置：粘贴进 Cursor / Claude 桌面版的 MCP 设置即可',
              )}>复制 JSON 配置</Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copySnippet(
                `[mcp_servers.aigc-hub]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${created.code}" }\n`,
                '已复制 TOML 配置：粘贴进 Codex 的 ~/.codex/config.toml 即可',
              )}>复制 TOML 配置</Button>
              <Button size="small" onClick={() => downloadConfig('claude')}>下载 .mcp.json</Button>
              <Button size="small" onClick={() => downloadConfig('codex')}>下载 config.toml</Button>
            </div>
            <Text type="secondary" className="block text-xs leading-relaxed">
              Cursor / Claude 桌面版：设置里找 MCP / 工具，选「添加远程 MCP 服务器」，URL 填 <Text code>{MCP_URL}</Text>，
              请求头加 <Text code>Authorization: Bearer 配对码</Text>。
              Codex CLI：把下载的 <Text code>config.toml</Text> 内容并进 <Text code>~/.codex/config.toml</Text>。
            </Text>
          </div>
        )}

        {created && (
          <pre className="max-h-[420px] overflow-auto rounded bg-black/5 dark:bg-white/10 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
            {guideText({ ...created, expiresAt: dayjs(created.expiresAt).format('YYYY-MM-DD HH:mm') })}
          </pre>
        )}
      </Modal>
    </Card>
  )
}
