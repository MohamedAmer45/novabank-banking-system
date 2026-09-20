pipeline {
  agent any
  stages {
    stage('Syntax') {
      steps {
        sh 'node --check server.js && node --check src/database.js && node --check src/banking.js && node --check public/app.js'
      }
    }
    stage('Start NovaBank') {
      steps {
        sh 'QA_MODE=true nohup node server.js > novabank-server.log 2>&1 & echo $! > novabank.pid'
        sh 'for i in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/api/health && break || sleep 1; done'
      }
    }
    stage('Smoke') {
      steps { sh 'node scripts/smoke.js' }
    }
  }
  post {
    always {
      sh 'cat novabank-server.log || true'
      sh 'test -f novabank.pid && kill $(cat novabank.pid) || true'
      archiveArtifacts artifacts: 'novabank-server.log', allowEmptyArchive: true
    }
  }
}
