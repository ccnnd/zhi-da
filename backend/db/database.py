# 数据库配置——异步 SQLAlchemy 引擎、会话工厂、建表初始化
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from config.settings import DATABASE_URL

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session


async def _ensure_enterprise(session: AsyncSession, eid: str, **kwargs):
    """幂等插入企业：不存在则插入，已存在则补空字段并强制同步 status。"""
    from db.models import Enterprise
    ent = await session.get(Enterprise, eid)
    if ent is None:
        ent = Enterprise(id=eid, **kwargs)
        session.add(ent)
        return
    # 补空字段
    for key, value in kwargs.items():
        if key == "status":
            continue  # status 单独处理，始终强制同步
        if getattr(ent, key, None) in (None, ""):
            setattr(ent, key, value)
    # status 始终与种子数据保持一致（防止持久化卷中残留旧状态）
    if "status" in kwargs:
        ent.status = kwargs["status"]


async def _ensure_job_post(session: AsyncSession, jid: str, **kwargs):
    """幂等插入岗位：不存在则插入，已存在则补空字段并强制同步 requirements_text。"""
    from db.models import JobPost
    jp = await session.get(JobPost, jid)
    if jp is None:
        jp = JobPost(id=jid, **kwargs)
        session.add(jp)
        return
    for key, value in kwargs.items():
        if key == "requirements_text":
            continue  # requirements_text 单独处理，始终强制同步
        if getattr(jp, key, None) in (None, ""):
            setattr(jp, key, value)
    # requirements_text 始终与种子数据保持一致（确保岗位要求描述与目标人群匹配）
    if "requirements_text" in kwargs:
        jp.requirements_text = kwargs["requirements_text"]


async def _ensure_ability_model(session: AsyncSession, job_post_id: str, **kwargs):
    """幂等插入能力模型：不存在则插入，已存在则跳过。"""
    from db.models import JobAbilityModel
    from sqlalchemy import select as _select
    result = await session.execute(
        _select(JobAbilityModel).where(JobAbilityModel.job_post_id == job_post_id)
    )
    if result.scalar_one_or_none() is None:
        session.add(JobAbilityModel(job_post_id=job_post_id, **kwargs))


async def _ensure_job_direction(session: AsyncSession, jid: str, **kwargs):
    """幂等插入系统岗位方向（jobs 表）：不存在则插入，已存在则跳过。"""
    from db.models import Job
    j = await session.get(Job, jid)
    if j is None:
        j = Job(id=jid, **kwargs)
        session.add(j)


# 迁移只运行一次（防止 TestClient lifespan 重复触发）
_growth_migrated = False


async def _migrate_single_phase_growth():
    """将旧版单阶段成长路径扩展为三阶段，并清除旧 GrowthTask 以触发重建。"""
    global _growth_migrated
    if _growth_migrated:
        return
    _growth_migrated = True

    import json as _json
    from db.models import DiagnosisResult, GrowthTask, TaskProgress
    from sqlalchemy import select as _select, delete as _delete

    _standard_3phases = [
        {"goal": "夯实基础", "weeks": 3, "tasks": [
            {"name": "核心技能专项训练", "description": "针对最薄弱的技能进行专项练习，打牢基础",
             "resources": [], "criteria": "技能评分达到65+",
             "linked_gap": "基础能力不足", "target_dimension": "tech_skills",
             "expected_impact": {"tech_skills": 0.05}}
        ]},
        {"goal": "项目实践", "weeks": 4, "tasks": [
            {"name": "实战项目开发", "description": "通过完整项目实践，将理论知识转化为实际能力",
             "resources": [], "criteria": "完成至少1个完整项目",
             "linked_gap": "缺乏项目经验", "target_dimension": "project_exp",
             "expected_impact": {"project_exp": 0.08}}
        ]},
        {"goal": "综合提升", "weeks": 3, "tasks": [
            {"name": "模拟面试与复盘", "description": "通过模拟面试查漏补缺，全面提升竞争力",
             "resources": [], "criteria": "模拟面试通过率80%+",
             "linked_gap": "综合竞争力", "target_dimension": "soft_skill_evidence",
             "expected_impact": {"soft_skill_evidence": 0.05}}
        ]},
    ]

    async with async_session() as session:
        result = await session.execute(_select(DiagnosisResult))
        diags = result.scalars().all()

        updated = 0
        for diag in diags:
            gp = diag.growth_path
            if not gp or not isinstance(gp, dict):
                continue
            phases = gp.get("phases", [])
            if not isinstance(phases, list) or len(phases) >= 2:
                continue

            # 旧数据：少于 2 个阶段 → 扩展为三阶段
            diag.growth_path = {"phases": _standard_3phases}

            # 删除旧的 GrowthTask 记录（将在下次 continue_growth 时从新 growth_path 重建）
            await session.execute(
                _delete(GrowthTask).where(GrowthTask.diagnosis_id == diag.id)
            )
            # 删除旧的 TaskProgress 记录
            await session.execute(
                _delete(TaskProgress).where(TaskProgress.diagnosis_id == diag.id)
            )
            updated += 1

        if updated > 0:
            await session.commit()


async def init_db():
    from db.models import Base, Enterprise, Job, JobPost, JobAbilityModel, StudentAttachment, AgentTrace
    async with engine.begin() as conn:
        await _migrate_student_id_type(conn)
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_sqlite_columns(conn)

    # 幂等种子：逐条 upsert，已有数据库也能补齐新增测试数据
    async with async_session() as session:
        # --- 企业 ---
        await _ensure_enterprise(session, '1', name='字节跳动', industry='互联网',
            description='字节跳动成立于2012年，是全球领先的科技公司之一。旗下产品包括今日头条、抖音、飞书等，致力于通过技术创新连接人与信息，覆盖全球超过150个国家和地区。',
            contact_name='张明辉', contact_email='zhangminghui@bytedance.com', status='active')
        await _ensure_enterprise(session, '2', name='阿里巴巴', industry='电子商务',
            description='阿里巴巴集团创立于1999年，是全球知名的数字商业基础设施平台，业务涵盖电子商务、云计算、数字媒体及娱乐、创新业务等多个领域，服务全球数亿消费者和数千万企业。',
            contact_name='李晓蕾', contact_email='lixiaolei@alibaba.com', status='active')
        await _ensure_enterprise(session, '3', name='星辰教育科技', industry='在线教育',
            description='星辰教育科技是一家专注于K12在线教育的创业公司，正处于资质审核阶段。',
            contact_name='王思远', contact_email='wangsiyuan@xingchen-edu.com', status='pending')
        await _ensure_enterprise(session, '4', name='鼎信金融', industry='金融科技',
            description='鼎信金融因涉嫌违规操作，当前处于系统禁用状态。',
            contact_name='赵立国', contact_email='zhaoliguo@dingxin-fin.com', status='disabled')
        await _ensure_enterprise(session, '5', name='华为技术', industry='通信与ICT',
            description='华为是全球领先的ICT基础设施和智能终端提供商，业务遍及170多个国家和地区。在5G通信、云计算、人工智能等前沿领域拥有深厚的技术积累，年研发投入超过1400亿元。',
            contact_name='陈志强', contact_email='chenzhiqiang@huawei.com', status='active')
        await _ensure_enterprise(session, '6', name='腾讯科技', industry='互联网',
            description='腾讯成立于1998年，是中国最大的互联网综合服务提供商之一。核心业务涵盖社交通讯（微信/QQ）、数字内容、网络游戏、金融科技及企业服务，月活跃用户超12亿。',
            contact_name='刘雅琪', contact_email='liuyaqi@tencent.com', status='active')
        await _ensure_enterprise(session, '7', name='美团', industry='本地生活服务',
            description='美团是中国领先的科技零售企业，以"零售+科技"战略连接消费者与商家，业务覆盖餐饮外卖、酒店旅游、到店服务、美团买菜、共享单车等领域，服务全国超7亿用户。',
            contact_name='孙浩然', contact_email='sunhaoran@meituan.com', status='active')
        await _ensure_enterprise(session, '8', name='小米科技', industry='消费电子',
            description='小米集团成立于2010年，是以手机、智能硬件和IoT平台为核心的消费电子及智能制造公司。坚持"感动人心、价格厚道"的理念，构建全球最大的消费级IoT平台。',
            contact_name='周文婷', contact_email='zhouwenting@xiaomi.com', status='active')

        # --- 系统岗位方向（jobs 表） ---
        _default_job_directions = [
            ('dir_01', 'Java后端开发', '后端开发', 'Java/Spring/MySQL/微服务'),
            ('dir_02', 'Python后端开发', '后端开发', 'Python/Django/FastAPI/Redis'),
            ('dir_03', '前端开发', '前端开发', 'React/Vue/TypeScript/CSS'),
            ('dir_04', '移动端开发', '移动端开发', 'Android/iOS/Flutter/React Native'),
            ('dir_05', 'AI/机器学习', '人工智能', 'Python/PyTorch/TensorFlow/NLP/CV'),
            ('dir_06', '数据科学', '数据科学', 'Python/SQL/Spark/数据挖掘/统计分析'),
            ('dir_07', '数据分析', '数据分析', 'SQL/Excel/Python/BI工具/业务分析'),
            ('dir_08', 'DevOps/SRE', '运维', 'Docker/Kubernetes/Linux/CICD/监控'),
            ('dir_09', '测试开发', '测试', '自动化测试/性能测试/测试框架/Java/Python'),
            ('dir_10', '产品经理', '产品', '需求分析/PRD/用户体验/数据分析/项目管理'),
            ('dir_11', 'UI/UX设计', '设计', 'Figma/Sketch/用户研究/交互设计'),
            ('dir_12', '网络安全', '安全', '渗透测试/安全架构/WAF/密码学'),
            ('dir_13', '嵌入式开发', '嵌入式', 'C/C++/RTOS/单片机/驱动开发/ARM'),
            ('dir_14', '游戏开发', '游戏开发', 'Unity/Unreal/C++/C#/图形学'),
            ('dir_15', '区块链开发', '区块链', 'Solidity/智能合约/Web3/共识算法'),
            ('dir_16', '云计算架构', '云计算', 'AWS/Azure/GCP/架构设计/迁移'),
            ('dir_17', '通信研发', '通信', '5G/LTE/协议栈/信号处理/C++'),
            ('dir_18', 'NLP算法工程师', '人工智能', 'Transformer/大模型/文本生成/语义理解'),
            ('dir_19', '计算机视觉工程师', '人工智能', 'CNN/GAN/目标检测/图像分割/视频分析'),
            ('dir_20', '推荐算法工程师', '算法', '推荐系统/CTR预估/用户画像/排序模型'),
            ('dir_21', '量化交易', '金融科技', 'Python/金融模型/回测/高频交易'),
            ('dir_22', '自动驾驶', '自动驾驶', '感知/规划控制/SLAM/C++/ROS'),
            ('dir_23', '音视频开发', '音视频', 'FFmpeg/WebRTC/编解码/流媒体'),
            ('dir_24', '数据库开发', '基础架构', 'MySQL/PostgreSQL/分布式存储/NewSQL'),
            ('dir_25', '全栈开发', '全栈开发', 'React/Node.js/PostgreSQL/Docker/全栈'),
        ]
        for jid, title, category, desc in _default_job_directions:
            await _ensure_job_direction(session, jid, title=title, category=category,
                description=f'{title}方向，涉及{desc}等技术栈', company='')

        # --- 企业岗位（job_posts 表） ---
        await _ensure_job_post(session, 'post_1', enterprise_id='1', title='Python后端开发工程师',
            category='后端开发',
            description='负责字节跳动核心业务平台的后端架构设计与开发工作，参与分布式微服务系统的设计与优化，保障亿级用户场景下的高可用与高性能。',
            requirements_text='【岗位职责】\n1. 负责公司核心业务平台的后端服务设计与开发，基于 Python/FastAPI 构建高性能微服务\n2. 设计并实现高并发、低延迟的分布式系统，包括任务调度、消息队列、缓存策略等\n3. 参与数据库架构设计，优化 SQL 查询性能，保障数据一致性与完整性\n4. 编写技术文档与接口规范，推动团队代码规范与 Code Review 文化\n5. 配合前端和算法团队完成跨模块联调与系统集成\n\n【任职要求】\n1. 本科及以上学历（含应届），计算机科学、软件工程等相关专业\n2. 扎实的 Python 编程基础，熟悉 FastAPI/Flask/Django 中至少一种 Web 框架\n3. 熟悉 MySQL、Redis 等主流存储方案，有数据库课程项目或竞赛经验优先\n4. 了解 Docker 等容器技术，有课程项目或个人项目实践经验\n5. 熟悉 Linux 基本操作，具备基本的调试与问题排查能力\n6. 学习能力强，有良好的逻辑思维与团队协作精神，有相关实习经验者优先',
            status='approved')
        await _ensure_job_post(session, 'post_2', enterprise_id='1', title='前端开发工程师',
            category='前端开发',
            description='负责抖音电商业务线的前端开发工作，参与用户端交互体验的设计与实现，推动前端工程化与性能优化，打造极致的购物体验。',
            requirements_text='【岗位职责】\n1. 负责抖音电商核心页面的开发与维护，包括商品详情页、购物车、结算流程等\n2. 基于 React + TypeScript 构建高性能单页应用，保障首屏加载速度与交互流畅度\n3. 主导前端性能优化，包括资源加载策略、渲染性能调优、Web Vitals 指标监控\n4. 参与前端组件库建设，沉淀可复用的业务组件与工具函数\n5. 与产品、设计团队紧密协作，将设计稿高保真还原为可交互的页面\n\n【任职要求】\n1. 本科及以上学历（含应届），计算机科学、软件工程或设计相关专业\n2. 扎实的 HTML/CSS/JavaScript 基础，理解浏览器渲染原理与事件机制\n3. 熟悉 React 生态（Hooks、状态管理、路由），有课程项目或个人项目经验\n4. 了解 Webpack/Vite 等构建工具，关注前端工程化最佳实践\n5. 了解 Node.js 基础，有 SSR/SSG 学习或实践经历优先\n6. 关注用户体验，有良好的设计审美和细节把控能力，有相关实习经验者优先',
            status='approved')
        await _ensure_job_post(session, 'post_3', enterprise_id='2', title='AI算法工程师',
            category='人工智能',
            description='加入通义千问大模型团队，参与多模态大语言模型的预训练、微调与推理优化，探索前沿AI技术在电商场景中的落地应用。',
            requirements_text='【岗位职责】\n1. 参与通义千问系列大模型的预训练数据构建、模型训练与效果评估\n2. 负责大模型在电商场景（智能客服、商品理解、内容生成）的微调与部署\n3. 研究并实现 RLHF、DPO 等对齐算法，提升模型的安全性与有用性\n4. 优化模型推理性能，包括量化压缩、KV Cache 管理、投机采样等技术\n5. 跟踪 NLP/CV 领域前沿论文，将研究成果转化为生产力\n\n【任职要求】\n1. 硕士及以上学历，计算机科学、人工智能、数学等相关专业\n2. 精通 PyTorch，有大规模模型训练经验（十亿级以上参数量优先）\n3. 熟悉 Transformer 架构原理，深入理解 Attention、位置编码等核心机制\n4. 有 LLM 微调经验（LoRA/QLoRA/全参数微调），了解 Prompt Engineering 最佳实践\n5. 熟悉分布式训练框架（DeepSpeed/Megatron/FSDP），有多卡/多机训练经验\n6. 在 ACL/EMNLP/NeurIPS/ICML 等顶会发表论文者优先',
            status='pending_review')
        await _ensure_job_post(session, 'post_4', enterprise_id='3', title='教育产品经理',
            category='产品', description='负责K12在线教育产品的规划与设计。',
            requirements_text='1. 教育行业经验\n2. 产品设计能力', status='approved')
        await _ensure_job_post(session, 'post_5', enterprise_id='4', title='金融数据分析师',
            category='数据', description='负责金融数据分析。',
            requirements_text='1. 数据分析能力\n2. 金融行业知识', status='approved')
        await _ensure_job_post(session, 'post_6', enterprise_id='5', title='5G协议栈开发工程师',
            category='通信研发',
            description='参与华为5G基站协议栈软件的设计与开发，负责RAN侧核心协议模块的实现与性能优化，推动5G-Advanced新特性的技术落地。',
            requirements_text='【岗位职责】\n1. 负责5G NR RAN侧协议栈软件开发，包括MAC、RLC、PDCP等协议层的设计与实现\n2. 参与5G-Advanced（R18/R19）新特性的技术方案设计与原型验证\n3. 进行协议栈性能优化，提升吞吐量、降低时延和CPU占用率\n4. 配合测试团队完成3GPP标准一致性测试与运营商入网测试\n5. 编写详细设计文档，参与技术评审与架构决策\n\n【任职要求】\n1. 硕士及以上学历，通信工程、电子信息、计算机科学等相关专业\n2. 熟悉3GPP 5G NR协议栈（L1/L2/L3），有LTE或NR协议开发经验\n3. 精通C/C++编程，具备良好的嵌入式软件开发习惯\n4. 了解O-RAN架构，有开放接口（E2/F1）开发经验优先\n5. 具有多核并行编程和实时系统开发经验\n6. 英语阅读能力良好，能流畅阅读3GPP标准文档',
            status='approved')
        await _ensure_job_post(session, 'post_7', enterprise_id='6', title='游戏客户端开发工程师',
            category='游戏开发',
            description='加入天美工作室群，参与大型3D手游客户端的核心架构开发，负责渲染管线优化与游戏引擎功能开发，为玩家打造沉浸式游戏体验。',
            requirements_text='【岗位职责】\n1. 负责手游客户端核心模块的架构设计与功能开发（基于Unity/自研引擎）\n2. 实现并优化3D渲染管线，包括PBR材质、实时光照、后处理特效等\n3. 开发游戏编辑器工具链，提升美术和策划团队的生产效率\n4. 进行客户端性能调优，关注帧率稳定性、内存占用和发热控制\n5. 解决多平台（iOS/Android/PC）适配和兼容性问题\n\n【任职要求】\n1. 本科及以上学历（含应届），计算机科学、图形学等相关专业\n2. 扎实的C++和C#编程基础，了解Unity引擎或Unreal引擎的基本架构\n3. 具备计算机图形学基础，理解渲染管线和着色器编程（HLSL/GLSL）基本概念\n4. 了解多线程编程和性能分析基础，有游戏开发课程项目或个人Demo\n5. 热爱游戏，对主流游戏的技术实现有研究和思考\n6. 有游戏开发实习经验或参加过Game Jam等游戏开发活动者优先',
            status='approved')
        await _ensure_job_post(session, 'post_8', enterprise_id='7', title='推荐算法工程师',
            category='算法',
            description='负责美团外卖推荐系统的算法迭代与优化，通过深度学习模型和实时特征工程提升推荐精准度，让每位用户都能高效发现心仪的美食与商家。',
            requirements_text='【岗位职责】\n1. 负责外卖首页信息流推荐算法的设计、开发与迭代优化\n2. 构建用户画像和商家画像体系，挖掘用户兴趣与行为模式\n3. 设计并训练多目标排序模型（CTR/CVR预估），优化推荐效果指标\n4. 搭建实时特征工程平台，接入用户实时行为、地理位置、时段等信号\n5. 参与推荐系统的A/B实验设计与效果分析，推动算法策略持续演进\n\n【任职要求】\n1. 硕士及以上学历，计算机科学、统计学、数学等相关专业\n2. 精通Python，熟悉TensorFlow/PyTorch深度学习框架\n3. 有推荐系统实战经验，熟悉DIN、DIEN、DeepFM等经典模型\n4. 了解Spark/Flink等大数据处理框架，有特征工程经验\n5. 熟悉SQL，能独立完成数据分析和效果评估\n6. 有O2O场景或LBS推荐经验优先，在KDD/RecSys等会议发表论文优先',
            status='approved')
        await _ensure_job_post(session, 'post_9', enterprise_id='8', title='Android系统开发工程师',
            category='移动端开发',
            description='加入小米手机系统部，参与MIUI/HyperOS核心功能的开发与优化，负责系统级应用和框架层的架构设计，为全球数亿MIUI用户打造流畅稳定的手机体验。',
            requirements_text='【岗位职责】\n1. 负责MIUI/HyperOS系统应用的开发与维护，涵盖设置、文件管理、安全中心等核心模块\n2. 参与Android Framework层的定制开发，实现差异化系统功能\n3. 进行系统级性能优化，包括启动速度、滑动流畅度、内存占用等关键指标\n4. 适配小米自研芯片（澎湃系列），优化底层硬件协同效率\n5. 参与跨平台技术方案调研，推动Kotlin Multiplatform在系统应用中的落地\n\n【任职要求】\n1. 本科及以上学历（含应届），计算机科学、电子工程等相关专业\n2. 扎实的Java或Kotlin编程基础，了解Android四大组件、Binder通信等核心机制\n3. 熟悉Android应用开发流程，有课程项目、竞赛项目或个人App开发经历\n4. 了解Android性能优化基本方法（内存泄漏检测、启动优化等）\n5. 对系统底层技术有兴趣，了解NDK/JNI基本概念者优先\n6. 对手机产品有热情，关注用户体验细节，有相关实习经验者优先',
            status='approved')
        await _ensure_job_post(session, 'post_10', enterprise_id='6', title='云原生后端开发工程师',
            category='后端开发',
            description='加入腾讯云云原生团队，负责容器服务（TKE）核心组件的开发与维护，参与Serverless、微服务治理等云原生产品的技术架构设计。',
            requirements_text='【岗位职责】\n1. 负责腾讯云容器服务（TKE）控制面和数据面的核心开发，保障百万级集群规模下的稳定性\n2. 设计开发Kubernetes Operator和自定义控制器，扩展平台能力\n3. 参与Serverless容器（如EKS弹性容器）的调度优化与冷启动加速\n4. 开发服务网格（Service Mesh）功能，包括流量管理、可观测性和安全策略\n5. 编写自动化运维工具，提升大规模集群的运维效率\n\n【任职要求】\n1. 本科及以上学历（含应届），计算机科学等相关专业\n2. 扎实的编程基础，熟悉Go语言或有意向深入学习，有后端开发课程项目经验\n3. 了解Kubernetes基本概念（Pod、Deployment、Service等），对云原生技术有浓厚兴趣\n4. 了解Docker容器基础，有容器化部署的课程项目或个人项目实践\n5. 了解分布式系统基本概念，对一致性协议（Raft等）有基础认知\n6. 有开源社区参与经历或技术博客者优先，学习能力强，有良好的自驱力',
            status='approved')

        # --- 能力模型 ---
        _w = {'tech_skills': 0.35, 'project_exp': 0.25, 'academic_foundation': 0.10, 'domain_knowledge': 0.15, 'soft_skill_evidence': 0.15}
        await _ensure_ability_model(session, 'post_1',
            tech_skills={'Python': 85, 'FastAPI': 75, 'MySQL': 70, 'Redis': 70, 'Docker': 60, 'Kubernetes': 55},
            soft_skills={'系统设计能力': 80, '团队协作': 70, '技术文档写作': 65},
            domain_knowledge={'后端开发': 85, '分布式系统': 75, '微服务架构': 70},
            project_exp=[
                {'name': '高并发Web服务开发', 'description': '基于Python/FastAPI开发日均千万请求的Web服务，包含限流、缓存、异步任务队列等实践'},
                {'name': '数据库性能优化', 'description': '完成MySQL分库分表方案设计与慢查询治理，提升系统整体响应速度'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_2',
            tech_skills={'React': 85, 'TypeScript': 80, 'CSS': 75, 'Webpack': 60, 'Node.js': 55},
            soft_skills={'用户体验意识': 80, '设计协作': 70, '学习能力': 75},
            domain_knowledge={'前端开发': 85, '前端工程化': 75, 'Web性能优化': 70},
            project_exp=[
                {'name': '电商前端系统开发', 'description': '使用React+TypeScript构建电商核心页面，实现SSR优化与性能监控'},
                {'name': '组件库建设', 'description': '沉淀20+可复用业务组件，覆盖表单、列表、弹窗等常见场景'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_3',
            tech_skills={'PyTorch': 90, 'Transformer': 85, '分布式训练': 80, 'Python': 85, 'CUDA': 60},
            soft_skills={'科研思维': 85, '论文阅读能力': 80, '问题分析': 75},
            domain_knowledge={'自然语言处理': 90, '深度学习': 85, '大模型技术': 90},
            project_exp=[
                {'name': '大模型预训练与微调', 'description': '参与十亿级参数大模型的预训练数据构建、LoRA微调及RLHF对齐'},
                {'name': '模型推理优化', 'description': '实现KV Cache优化、INT8量化等技术，将推理延迟降低40%'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_6',
            tech_skills={'C/C++': 90, '嵌入式开发': 80, 'Linux': 75, '信号处理': 70},
            soft_skills={'协议理解能力': 85, '严谨性': 80, '跨部门协作': 70},
            domain_knowledge={'5G通信协议': 90, '无线通信': 85, '嵌入式系统': 75},
            project_exp=[
                {'name': '5G基站协议栈开发', 'description': '完成NR MAC层调度算法实现与性能调优，满足3GPP标准一致性要求'},
                {'name': '实时系统优化', 'description': '优化多核并行处理流水线，将基带处理时延降低30%'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_7',
            tech_skills={'C++': 90, 'C#': 70, 'Unity': 80, 'HLSL': 75, '图形学': 85},
            soft_skills={'性能优化意识': 85, '美术协作': 70, '问题排查': 80},
            domain_knowledge={'计算机图形学': 90, '游戏引擎': 85, '移动端优化': 75},
            project_exp=[
                {'name': '3D渲染管线开发', 'description': '实现PBR材质系统和实时全局光照方案，提升画面品质'},
                {'name': '客户端性能调优', 'description': '针对移动端GPU特性优化Draw Call和Overdraw，帧率提升20%'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_8',
            tech_skills={'Python': 85, 'PyTorch': 80, 'TensorFlow': 70, 'Spark': 70, 'SQL': 75},
            soft_skills={'数据敏感度': 80, '实验设计能力': 75, '业务理解': 70},
            domain_knowledge={'推荐系统': 90, '机器学习': 85, '计算广告': 70},
            project_exp=[
                {'name': '推荐排序模型开发', 'description': '设计并训练多目标排序模型，线上CTR提升8%，GMV提升5%'},
                {'name': '实时特征工程', 'description': '搭建Flink实时特征平台，接入用户行为序列和上下文特征'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_9',
            tech_skills={'Kotlin': 85, 'Java': 80, 'Android Framework': 80, 'C/C++': 65, 'NDK': 60},
            soft_skills={'系统思维': 80, '性能优化意识': 75, '用户导向': 70},
            domain_knowledge={'Android系统': 90, '移动端开发': 85, '操作系统': 70},
            project_exp=[
                {'name': '系统应用开发', 'description': '负责Android系统应用开发，优化设置页面启动速度提升40%'},
                {'name': 'Framework定制开发', 'description': '基于Android Framework实现自定义手势交互与多窗口管理功能'}
            ], weight_config=_w)
        await _ensure_ability_model(session, 'post_10',
            tech_skills={'Go': 90, 'Kubernetes': 85, 'Docker': 80, 'gRPC': 70, 'etcd': 65},
            soft_skills={'架构设计能力': 85, '开源协作': 75, '技术推动力': 80},
            domain_knowledge={'云原生': 90, '容器编排': 85, '分布式系统': 80},
            project_exp=[
                {'name': 'Kubernetes控制器开发', 'description': '设计并实现自定义Operator，管理百万级Pod的调度和生命周期'},
                {'name': 'Serverless容器优化', 'description': '优化冷启动流程，将容器启动时间从5秒降低到800毫秒'}
            ], weight_config=_w)

        await session.commit()

    # 迁移：将旧版单阶段成长路径扩展为三阶段
    await _migrate_single_phase_growth()


async def _migrate_student_id_type(conn):
    """If students.id is VARCHAR (old schema), drop all tables so they get recreated with INTEGER."""
    if engine.dialect.name != "sqlite":
        return
    try:
        result = await conn.execute(text("PRAGMA table_info(students)"))
        rows = result.fetchall()
    except Exception:
        return
    if not rows:
        return  # table doesn't exist yet
    for row in rows:
        col_name, col_type = row[1], row[2]
        if col_name == "id" and "INT" not in col_type.upper():
            # Old schema: id was VARCHAR/TEXT. Drop all tables for a clean recreation.
            from db.models import Base
            await conn.run_sync(Base.metadata.drop_all)
            return


async def _ensure_sqlite_columns(conn):
    """Apply small SQLite schema upgrades for existing local/demo databases."""
    if engine.dialect.name != "sqlite":
        return

    migrations = {
        "students": {
            "academic_foundation": "JSON DEFAULT '{}'",
            "soft_skill_evidence": "JSON DEFAULT '{}'",
            "profile_sections": "JSON DEFAULT '{}'",
            "profile_completeness": "REAL DEFAULT 0.0",
            "phone": "TEXT DEFAULT ''",
            "email": "TEXT DEFAULT ''",
            "school": "TEXT DEFAULT ''",
            "education_level": "TEXT DEFAULT ''",
            "self_evaluation": "TEXT DEFAULT ''",
        },
        "diagnosis_results": {
            "ability_profile": "JSON DEFAULT '{}'",
            "explanations": "JSON DEFAULT '{}'",
            "confidence": "JSON DEFAULT '{}'",
            "input_snapshot": "JSON DEFAULT '{}'",
            "job_snapshot": "JSON DEFAULT '[]'",
            "model_name": "TEXT DEFAULT ''",
            "prompt_version": "TEXT DEFAULT ''",
            "agent_version": "TEXT DEFAULT ''",
            "ai_status": "TEXT DEFAULT 'available'",
        },
    }

    for table, columns in migrations.items():
        result = await conn.execute(text(f"PRAGMA table_info({table})"))
        existing = {row[1] for row in result.fetchall()}
        for column, definition in columns.items():
            if column not in existing:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
