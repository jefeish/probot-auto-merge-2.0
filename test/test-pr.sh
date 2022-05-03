# -----------------------------------------------
# Little script to test 'probot-auto-merge' tasks
# (we expect the Repo to be cloned already)
# inside the 'headRepo-folder'...
# 1. checkout 'development' repo
# 2. create 'patch' branch
# 3. update a file in the 'patch' branch
# 4. check in the changes (push 'patch' repo upstream)
# 5. create GitHub PR
# 6. Add 'Label' and 'Reviewer'
# 7. Return the PR URL (for approval)
# -----------------------------------------------

# configure
d=`date +%Y-%m-%d_%H-%M-%S`
repo="repos_02"
baseBranch="release/1.2"
headBranch="release/1.1"
owner="jefeish"
assignee="jester01248"
OAUTHTOKEN=""

if [ $# -gt 1 ] && [ $# -eq 12 ]
then
    while getopts r:o:h:b:a:t: option
    do
    case "${option}"
    in
    r) repo=${OPTARG};;
    o) owner=${OPTARG};;
    h) headBranch=${OPTARG};;
    b) baseBranch=${OPTARG};;
    a) assignee=${OPTARG};;
    t) OAUTHTOKEN=${OPTARG};;
    esac
    done
else
    echo
    echo " Usage"
    echo "----------"
    echo " Parameters: \n -r <repo> \n -o <owner> \n -h <headBranch> \n -b <baseBranch> \n -a <assignee> \n -t <OAUTHTOKEN> \n"
    echo " Example:"
    echo "   $0 -r repo_02 -o jefeish -h my_head_branch -b my_base_branch -a jester01248 -t 35427e1ae... \n"
    exit 0
fi 

# make the Patch
# ---------------
# safety measure
git checkout ${baseBranch}
git pull origin ${baseBranch}
# new PR branch
git checkout ${headBranch}
git pull origin ${headBranch}
echo "dummy update to test PR... ${d}" >> test-pr.md
git add .
git commit -m "dummy update to test PR - ${d}"
git push -u origin ${headBranch}

# create a GitHub PR
# -------------------
echo
echo " --- Create the PR --------------------------------------------------"
echo
issue_number=`curl -X POST -H "Authorization: token $OAUTHTOKEN" -d "{ \"title\": \"Amazing new feature\", \"body\": \"Please pull these awesome changes in!\", \"head\": \"${headBranch}\", \"base\": \"${baseBranch}\" }" https://api.github.com/repos/${owner}/${repo}/pulls | jq .number`
echo " --- Update the PR (add label) --------------------------------------"
echo "issue_number: ${issue_number}"
pr_url=`curl -X PATCH -H "Authorization: token $OAUTHTOKEN" -d "{ \"labels\": [\"merge\"] }"  https://api.github.com/repos/${owner}/${repo}/issues/${issue_number} | jq .pull_request.html_url`
echo " --- Update the PR (add reviewer) -----------------------------------"
res=`curl -X POST -H "Authorization: token $OAUTHTOKEN" -d "{\"reviewers\": [\"${assignee}\"]}"  https://api.github.com/repos/${owner}/${repo}/pulls/${issue_number}/requested_reviewers`
echo
echo " --- Approve the PR -------------------------------------------------"
echo
# curl -X GET -H "Authorization: token 4ef500f0bc023a98ab4367a9d2fc44c5b3519380" https://api.github.com/repos/jefeish/repos_01/pulls/58/reviews

git checkout development

echo "-------------------------------------------------------------------------"
echo " PULL REQUEST URL: ${pr_url}"
echo " Reviewers should use this URL to 'approve' the PR"
echo "-------------------------------------------------------------------------"
