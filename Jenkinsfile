pipeline {
  agent any

  environment {
    DATABASE_URL = "${env.NOVABANK_DATABASE_URL}"
    DATABASE_SSL = 'false'
    QA_MODE      = 'true'
    PORT         = '3000'
  }

  stages {
    stage('Install') {
      steps { sh 'npm ci' }
    }

    stage('Syntax') {
      steps {
        sh 'npm run check'
        sh 'node --check public/app.js'
      }
    }

    stage('Migrate and seed') {
      steps {
        sh 'node scripts/migrate.js --reset'
        sh 'node scripts/seed.js'
      }
    }

    stage('Start NovaBank') {
      steps {
        sh 'nohup node server.js > novabank-server.log 2>&1 & echo $! > novabank.pid'
        sh '''
          for i in $(seq 1 30); do
            curl -fsS http://127.0.0.1:3000/api/health && exit 0
            sleep 1
          done
          echo "Application did not become healthy."
          exit 1
        '''
      }
    }

    stage('Smoke') {
      steps { sh 'npm run smoke' }
    }

    stage('Ledger reconciliation') {
      steps { sh 'npm run db:check' }
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
