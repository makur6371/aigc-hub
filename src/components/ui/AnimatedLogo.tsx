'use client'

import { useEffect, useId, useRef } from 'react'
import { ORG } from '@/lib/site-content'

/**
 * 品牌 Logo 加载动画（两个版本，按场景选用）：
 *
 * 1. 纯 Logo 版（默认，不传 showWordmark）—— 只有 Logo 动画本体。
 *    适用：小尺寸、高频出现的场合（导航栏、面板角落、行内 loading、
 *    CopilotPanel 等24–48px 的位置）。字标在这些尺寸下会糊成一团。
 *
 * 2. 字标版（showWordmark）—— Logo 动画 + 下方品牌名字标（取自 ORG.name），
 *    字母与 Logo 共用同一条 3.6s 时间轴：32–51% 字母从左到右逐个弹入
 *    （与方块弹入节奏咬合），51–78% 稳定停留，78–88% 字母先收走、
 *    Logo 随后消散。
 *    适用：大尺寸、用户等待感明显的"仪式感"场合（根路由 loading.tsx、
 *    登录/注册页、画布全屏加载等 64px+ 的位置）。
 *
 * 动画时间轴（3.6s 循环，所有部件单时钟同步）：
 *   0–38%   丝带四件从各自方向滑入编织（浅环←左上、左柱←左、斜带←右上、月牙←右下）
 *   30–51%  四个像素方块沿对角线依次弹入
 *   38–58%  窄高光沿对角线扫过（mask 限制在图形内）
 *   62%     轻微呼吸放大
 *   80–100% 消散，回到空场
 *
 * 预览（可直接浏览器打开，?t=0.5 可冻结任意时刻）：
 *   docs/logo-animation-preview.html    —— 纯 Logo 版
 *   docs/logo-animation-preview-v2.html —— 字标版
 *
 * @example
 *   <AnimatedLogo size={64} />                            // 纯 Logo
 *   <AnimatedLogo size={72} showWordmark />               // Logo + 字标
 *   <AnimatedLogo size={30} className="shrink-0 ml-3" />  // 行内小尺寸
 */
export interface AnimatedLogoProps {
  size?: number
  className?: string
  /** 显示下方品牌名字标（与 Logo 动画同步）。大尺寸场景用，小尺寸（<48px）不建议开。 */
  showWordmark?: boolean
}

// 逐字弹入的字标。中文名比英文短，动画节奏仍按 54ms/字 咬合像素方块（见下方注释）。
const WORD = ORG.name.replace(/\s/g, '').split('')

const PATHS = {
  loop: 'M272 343.088C308.494 333.289 355.155 339.534 387.469 358.83C412.556 373.81 440.441 404.589 461.84 425.99L548.632 513.263L604.416 569.269C611.972 576.901 624.954 589.305 631.56 597.227C606.952 621.46 582.523 645.875 558.275 670.469C545.1 683.781 530.218 699.658 516.883 712.437C485.399 683.871 455.763 652.268 424.77 623.1C419.213 617.869 413.369 612.243 408.032 606.79C405.635 605.595 387.134 586.958 384.013 583.963L321.227 523.837C309.43 512.621 296.054 499.527 283.491 489.412C266.372 475.63 230.497 460.208 208.052 463.125L204.369 462.824L199.72 462.923C177.114 467.222 169.579 476.834 161.465 497.693C160.822 494.177 160.95 486.686 161.085 483.044C162.036 457.345 171.351 428.297 184.891 406.378C204.185 375.145 236.009 351.345 272 343.088Z',
  column: 'M204.369 462.824L208.052 463.125C215.516 470.295 225.664 483.188 232.489 491.377C244.325 505.564 256.251 519.676 268.265 533.712C275.172 541.821 285.63 556.196 295.231 560.194C310.556 552.275 318.966 549.033 336.681 546.79L336.567 554.922L336.525 735.807L336.503 782.702C336.49 798.843 336.084 816.137 339.027 831.987C341.617 845.94 351.555 873.047 364.282 880.963C354.095 887.909 345.04 894.187 333.772 899.615C307.926 912.065 279.2 915.245 251.078 910.014C247.382 909.327 239.634 907.419 236.197 905.925C231.052 904.549 225.183 902.025 220.382 899.721C208.342 894.825 197.958 885.409 188.899 876.611L187.479 876.828C186.111 875.165 183.445 870.162 182.29 868.091C172.773 851.024 165.63 831.401 162.608 812.091C160.43 798.169 160.948 782.344 160.958 768.122L160.993 714.074C161.014 658.042 160.239 599.86 161.105 544.003C160.688 539.333 160.918 529.801 160.933 524.851C160.957 516.409 160.695 505.952 161.465 497.693C169.579 476.834 177.114 467.222 199.72 462.923L204.369 462.824Z',
  band: 'M721.599 520.326C731.395 509.621 741.838 499.458 751.946 489.046C785.692 454.287 816.683 426.682 868.021 424.429C873.749 424.178 882.878 422.775 887.514 426.838C889.871 428.903 889.784 431.971 889.843 434.866C890.123 448.725 889.617 462.707 889.557 476.578C889.535 481.668 889.076 487.067 889.544 492.112C889.673 493.509 889.987 494.923 891.056 495.919C898.341 502.701 952.384 494.698 959.121 499.443C960.684 500.543 961.347 502.843 961.561 504.643C963.091 517.481 957.811 533.152 949.669 543.034C944.741 549.015 938.452 553.886 932.328 558.578C926.251 564.86 917.812 571.754 911.284 577.967C900.856 587.981 887.212 601.838 876.515 610.994C873.771 614.29 870.244 617.574 867.122 620.562C851.728 635.302 836.702 650.415 821.618 665.472L700.188 786.909C668.912 817.925 637.827 849.133 606.936 880.532C599.085 888.391 591.297 896.312 583.574 904.295C577.849 910.256 570.089 918.838 563.83 923.994C547.693 937.285 528.514 948.126 509.062 955.77C507.434 956.41 501.839 958.48 500.524 958.657C470.932 969.447 440.094 974.323 408.73 973.712C402.016 973.581 394.608 974.042 387.961 973.588C372.06 975.334 336.491 972.148 320.716 968.651C264.08 956.096 218.996 925.686 187.479 876.828L188.899 876.611C197.958 885.409 208.342 894.825 220.382 899.721C225.183 902.025 231.052 904.549 236.197 905.925C239.634 907.419 247.382 909.327 251.078 910.014C279.2 915.242 307.926 912.065 333.772 899.615C345.04 894.187 354.095 887.909 364.282 880.963C368.979 877.191 374.044 873.471 378.863 869.823C387.899 862.351 401.23 847.79 409.881 838.889L463.474 783.881L627.688 615.745L691.351 551.012C700.669 541.583 712.002 529.05 721.599 520.326Z',
  crescent: 'M932.328 558.578C947.736 565.608 960.866 572.655 973.877 583.79C1036.32 637.232 1052.47 728.492 1033.03 805.439C1018.93 861.289 978.499 916.599 928.845 945.884C864.75 986.199 773.666 983.84 717.022 931.135C741.871 906.846 766.066 881.239 790.983 857.048C799.177 848.376 808.562 839.527 816.981 830.835C827.175 820.312 837.898 809.146 848.335 798.923C856.066 791.961 864.785 786.181 872.404 779.069C929.349 725.915 955.434 648.763 911.284 577.967C917.812 571.755 926.251 564.86 932.328 558.578Z',
  tail: 'M790.983 857.048C794.791 858.396 803.54 855.986 807.947 855.965C815.353 855.929 822.984 855.341 830.333 856.616C833.838 857.208 838.32 860.639 841.472 862.383C847.443 866.559 852.549 871.092 858.623 875.349C865.945 880.481 874.143 885.141 881.142 890.428C883.691 892.354 887.093 899.46 890.511 902.289C894.439 905.765 901.939 908.068 904.825 912.395C907.313 916.153 907.989 922.304 910.781 925.758C914.002 929.742 918.264 934.575 922.206 937.91C926.098 941.202 926.125 942.71 928.845 945.884C864.75 986.199 773.666 983.84 717.022 931.135C741.871 906.846 766.066 881.239 790.983 857.048Z',
  sqC: 'M928.437 333.231C936.939 332.638 983.226 332.034 989.835 333.919C994.245 335.176 996.453 338.824 998.566 342.576C999.11 362.397 998.632 384.501 998.646 404.509C1007.87 404.612 1055.68 402.971 1061.28 405.911C1064.01 407.344 1066.41 410.101 1067.16 413.126C1068.77 419.628 1068.28 457.35 1067.42 465.248C1067.17 467.461 1066.84 469.469 1065.68 471.394C1063.16 475.581 1058.77 477.583 1054.22 478.757L1018.22 478.877C989.213 478.96 989.973 479.655 990.02 451.17L990.082 413.768C979.962 413.819 927.04 415.18 920.896 412.902C918.396 411.975 915.936 409.63 914.977 407.125C913.198 402.479 913.848 356.363 914.332 349.381C914.466 347.447 914.723 345.458 915.551 343.684C918.171 338.071 922.829 335.261 928.437 333.231Z',
  sqA: 'M1053.16 220.461C1062.1 219.985 1094.88 219.366 1101.81 221.037C1104.41 221.662 1106.81 223.876 1108.04 226.201C1110.08 230.044 1110.28 271.772 1108.74 276.84C1107.71 280.243 1104.48 281.959 1101.54 283.48C1090.85 283.512 1059.99 284.813 1051.66 282.941C1049.23 282.395 1047.55 281.033 1046.32 278.896C1044.31 275.419 1044.3 231.655 1045.88 227.081C1047.03 223.786 1050.24 221.951 1053.16 220.461Z',
  sqD: 'M1106.93 328.871C1114.76 328.625 1142.21 327.53 1148.31 329.31C1150.83 330.045 1153.27 332.352 1154.42 334.678C1156.49 338.866 1156.07 374.614 1154.29 379.57C1153.24 382.51 1150.13 383.9 1147.57 385.239C1133.96 385.391 1119.7 385.938 1106.15 384.847C1097.81 384.436 1098.36 366.756 1099 360.356C1100.21 348.212 1094.28 334.844 1106.93 328.871Z',
  sqB: 'M990.501 285.893L1004.17 285.478C1012.22 285.289 1013.94 290.285 1013.57 297.433C1013.29 302.725 1014.6 305.293 1010.57 309.237C997.21 309.462 985.064 314.065 987.31 295.276C987.907 290.287 986.305 289.799 990.501 285.893Z',
}

export function AnimatedLogo({ size = 64, className = '', showWordmark = false }: AnimatedLogoProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  // 用 useId 生成稳定唯一 id：模块级计数器在 SSR 与客户端会得到不同序号，
  // 导致渐变 id 不匹配（hydration mismatch）。useId 两端一致，天然可安全用于 SVG id。
  const uid = `mk${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    // Restart CSS animations on remount so multiple instances stay in sync
    const svg = svgRef.current
    if (!svg) return
    svg.getAnimations({ subtree: true }).forEach((anim) => {
      anim.currentTime = 0
      anim.play()
    })
  }, [])

  const g = (id: string) => `url(#${uid}-${id})`

  const wordPx = Math.max(9, Math.round(size * 0.155))

  const logoSvg = (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1254 1254"
      className={`mk-anim-logo ${className}`}
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${uid}-lg-band`} gradientUnits="userSpaceOnUse" x1="675.258" y1="465.56" x2="598.833" y2="999.258">
          <stop offset="0" stopColor="#7D50E0" /><stop offset="1" stopColor="#906BE4" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-loop`} gradientUnits="userSpaceOnUse" x1="597.592" y1="640.756" x2="216.653" y2="363.427">
          <stop offset="0" stopColor="#9068E6" /><stop offset="1" stopColor="#C4AEF9" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-column`} gradientUnits="userSpaceOnUse" x1="259.51" y1="560.639" x2="261.979" y2="911.244">
          <stop offset="0" stopColor="#5F26D5" /><stop offset="1" stopColor="#BAA2F3" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-crescent`} gradientUnits="userSpaceOnUse" x1="1031.275" y1="629.174" x2="832.42" y2="888.03">
          <stop offset="0" stopColor="#4704D1" /><stop offset="1" stopColor="#875DE1" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-tail`} gradientUnits="userSpaceOnUse" x1="864.589" y1="878.003" x2="791.934" y2="982.985">
          <stop offset="0" stopColor="#8559E1" /><stop offset="1" stopColor="#9F7EEA" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-sq-c`} gradientUnits="userSpaceOnUse" x1="1056.314" y1="384.328" x2="922.684" y2="428.172">
          <stop offset="0" stopColor="#6831D9" /><stop offset="1" stopColor="#8861DF" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-sq-a`} gradientUnits="userSpaceOnUse" x1="1110.705" y1="269.791" x2="1042.998" y2="234.255">
          <stop offset="0" stopColor="#6E36D8" /><stop offset="1" stopColor="#9776E6" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-sq-d`} gradientUnits="userSpaceOnUse" x1="1156.216" y1="372.354" x2="1097.348" y2="341.131">
          <stop offset="0" stopColor="#6F38D8" /><stop offset="1" stopColor="#916EE4" />
        </linearGradient>
        <linearGradient id={`${uid}-lg-sq-b`} gradientUnits="userSpaceOnUse" x1="1012.582" y1="303.322" x2="987.668" y2="291.476">
          <stop offset="0" stopColor="#A07EEA" /><stop offset="1" stopColor="#C4AFF7" />
        </linearGradient>
        <linearGradient id={`${uid}-sheen`} gradientUnits="userSpaceOnUse" x1="380" y1="180" x2="880" y2="680">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <mask id={`${uid}-sheen-mask`}>
          <g fill="#fff">
            <path d={PATHS.loop} /><path d={PATHS.column} /><path d={PATHS.band} />
            <path d={PATHS.crescent} /><path d={PATHS.tail} />
            <path d={PATHS.sqC} /><path d={PATHS.sqA} /><path d={PATHS.sqD} /><path d={PATHS.sqB} />
          </g>
        </mask>
      </defs>

      <g className="mk-breathe">
        <g className="mk-piece mk-loop"><path fill={g('lg-loop')} d={PATHS.loop} /></g>
        <g className="mk-piece mk-column"><path fill={g('lg-column')} d={PATHS.column} /></g>
        <g className="mk-piece mk-band"><path fill={g('lg-band')} d={PATHS.band} /></g>
        <g className="mk-piece mk-crescent"><path fill={g('lg-crescent')} d={PATHS.crescent} /></g>
        <g className="mk-piece mk-tail"><path fill={g('lg-tail')} d={PATHS.tail} /></g>
        <g className="mk-piece mk-sq mk-sq-c"><path fill={g('lg-sq-c')} d={PATHS.sqC} /></g>
        <g className="mk-piece mk-sq mk-sq-a"><path fill={g('lg-sq-a')} d={PATHS.sqA} /></g>
        <g className="mk-piece mk-sq mk-sq-d"><path fill={g('lg-sq-d')} d={PATHS.sqD} /></g>
        <g className="mk-piece mk-sq mk-sq-b"><path fill={g('lg-sq-b')} d={PATHS.sqB} /></g>
        <g className="mk-sheen" mask={`url(#${uid}-sheen-mask)`}>
          <rect x="-300" y="-300" width="1900" height="1900" fill={g('sheen')} />
        </g>
      </g>

      <style>{`
        .mk-anim-logo { overflow: visible; }
        .mk-anim-logo .mk-piece { opacity: 0; }
        .mk-anim-logo .mk-loop     { animation: mk-loop     3.6s cubic-bezier(.22,1.15,.32,1) infinite; }
        .mk-anim-logo .mk-column   { animation: mk-column   3.6s cubic-bezier(.22,1.15,.32,1) infinite; }
        .mk-anim-logo .mk-band     { animation: mk-band     3.6s cubic-bezier(.22,1.15,.32,1) infinite; }
        .mk-anim-logo .mk-crescent { animation: mk-crescent 3.6s cubic-bezier(.22,1.15,.32,1) infinite; }
        .mk-anim-logo .mk-tail     { animation: mk-tail     3.6s cubic-bezier(.22,1.15,.32,1) infinite; }
        .mk-anim-logo .mk-sq-c     { animation: mk-sq-c     3.6s cubic-bezier(.34,1.56,.64,1) infinite; }
        .mk-anim-logo .mk-sq-b     { animation: mk-sq-b     3.6s cubic-bezier(.34,1.56,.64,1) infinite; }
        .mk-anim-logo .mk-sq-a     { animation: mk-sq-a     3.6s cubic-bezier(.34,1.56,.64,1) infinite; }
        .mk-anim-logo .mk-sq-d     { animation: mk-sq-d     3.6s cubic-bezier(.34,1.56,.64,1) infinite; }
        .mk-anim-logo .mk-sheen    { opacity: 0; animation: mk-sheen 3.6s ease-in-out infinite; mix-blend-mode: screen; pointer-events: none; }
        .mk-anim-logo .mk-breathe  { animation: mk-breathe  3.6s ease-in-out infinite; transform-origin: 627px 627px; }
        @keyframes mk-loop     { 0% { opacity:0; transform: translate(-190px,-190px); } 12% { opacity:1; } 22%,78% { opacity:1; transform: translate(0,0); } 88%,100% { opacity:0; transform: translate(60px,-30px); } }
        @keyframes mk-column   { 0% { opacity:0; transform: translate(-170px,60px); } 16% { opacity:1; } 26%,78% { opacity:1; transform: translate(0,0); } 88%,100% { opacity:0; transform: translate(-70px,40px); } }
        @keyframes mk-band     { 0% { opacity:0; transform: translate(230px,-230px); } 20% { opacity:1; } 30%,78% { opacity:1; transform: translate(0,0); } 88%,100% { opacity:0; transform: translate(90px,90px); } }
        @keyframes mk-crescent { 0% { opacity:0; transform: translate(200px,120px); } 24% { opacity:1; } 34%,78% { opacity:1; transform: translate(0,0); } 88%,100% { opacity:0; transform: translate(120px,60px); } }
        @keyframes mk-tail     { 0% { opacity:0; transform: translate(150px,190px); } 28% { opacity:1; } 38%,78% { opacity:1; transform: translate(0,0); } 88%,100% { opacity:0; transform: translate(80px,90px); } }
        @keyframes mk-sq-c     { 0%,30% { opacity:0; transform: translate(120px,-120px) scale(.2); } 40%,78% { opacity:1; transform: translate(0,0) scale(1); } 88%,100% { opacity:0; transform: translate(60px,-60px) scale(.5); } }
        @keyframes mk-sq-b     { 0%,34% { opacity:0; transform: translate(90px,-90px) scale(.2); } 43%,78% { opacity:1; transform: translate(0,0) scale(1); } 88%,100% { opacity:0; transform: translate(45px,-45px) scale(.5); } }
        @keyframes mk-sq-a     { 0%,38% { opacity:0; transform: translate(110px,-110px) scale(.2); } 47%,78% { opacity:1; transform: translate(0,0) scale(1); } 88%,100% { opacity:0; transform: translate(55px,-55px) scale(.5); } }
        @keyframes mk-sq-d     { 0%,42% { opacity:0; transform: translate(130px,-90px) scale(.2); } 51%,78% { opacity:1; transform: translate(0,0) scale(1); } 88%,100% { opacity:0; transform: translate(65px,-45px) scale(.5); } }
        @keyframes mk-sheen    { 0%,38% { opacity:0; transform: translate(-560px,-560px); } 46% { opacity:1; } 58%,100% { opacity:0; transform: translate(560px,560px); } }
        @keyframes mk-breathe  { 0%,40%,80%,100% { transform: scale(1); } 62% { transform: scale(1.035); } }
        @media (prefers-reduced-motion: reduce) {
          .mk-anim-logo .mk-piece, .mk-anim-logo .mk-sheen, .mk-anim-logo .mk-breathe {
            animation: none !important; opacity: 1 !important; transform: none !important;
          }
          .mk-anim-logo .mk-sheen { opacity: 0 !important; }
        }
      `}</style>
    </svg>
  )

  if (!showWordmark) return logoSvg

  // 字标版：字母逐个弹入的延迟（54ms/字母），最后一个字母约在时间轴 51% 处落位，
  // 与像素方块的弹入节奏咬合。改字标文案只需改 WORD 常量。
  return (
    <div className="mk-lockup flex flex-col items-center" style={{ gap: size * 0.11 }}>
      {logoSvg}
      <div
        className="mk-word"
        style={{
          fontSize: wordPx,
          fontWeight: 700,
          letterSpacing: '0.18em',
          display: 'flex',
          overflow: 'hidden',
          padding: '0 0.18em',
          lineHeight: 1.2,
        }}
      >
        {WORD.map((ch, i) => (
          <span
            key={i}
            className="mk-letter"
            style={{
              display: 'inline-block',
              background: 'linear-gradient(120deg, #7d50e0 0%, #906be4 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
              opacity: 0,
              animation: `mk-letter 3.6s cubic-bezier(.34,1.56,.64,1) infinite`,
              animationDelay: `${i * 0.054}s`,
            }}
          >
            {ch}
          </span>
        ))}
      </div>
      <style>{`
        @keyframes mk-letter {
          0%, 32% { opacity: 0; transform: translateY(14%); }
          40%, 78% { opacity: 1; transform: translateY(0); }
          88%, 100% { opacity: 0; transform: translateY(-10%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mk-word .mk-letter { animation: none !important; opacity: 1 !important; transform: none !important; }
        }
      `}</style>
    </div>
  )
}
