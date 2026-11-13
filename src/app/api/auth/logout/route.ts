import { NextResponse } from 'next/server'
import { apiHandler } from '@/lib/api-handler'

export const POST = apiHandler(async () => {
  const response = NextResponse.json({ success: true, data: null, message: '已退出登录' })
  response.cookies.set('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  })
  return response
})
