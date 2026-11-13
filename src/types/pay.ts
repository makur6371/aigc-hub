export type RechargePackage = {
  id: string
  name: string
  priceCents: number
  points: number
  beans: number
  /** 订阅套餐：激活后一次性发放 points/beans */
  isSubscription?: boolean
  /** 套餐类型（前端分组展示）：points / beans / subscription */
  kind?: string
  durationDays?: number | null
  /** 订阅套餐附带的免费无限生图天数（3/5/10） */
  freeImageDays?: number | null
  sortOrder: number
}

export type PayChannel = 'wxpay' | 'alipay'

export type RechargeState = {
  orderNo: string
  orderId: string
  money: string
  name: string
  channel: PayChannel
  /** 网关收银台跳转 URL（submit.php，进入后点支付扫码/直接支付） */
  checkoutUrl: string | null
}

export type RechargeOrderStatus = 'PENDING' | 'PAID' | 'CLOSED'

export type RechargeOrderItem = {
  orderNo: string
  name: string
  priceCents: number
  points: number
  beans: number
  isSubscription?: boolean
  durationDays?: number | null
  status: RechargeOrderStatus
  paidAt: string | null
  createdAt: string
}
