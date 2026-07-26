# 环境检查
$env:Path = "$env:USERPROFILE\scoop\shims;$env:Path"
make --version
make doctor
# 启动
make dev
